package top.cloudgenshin.wordexcite;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.MediaPlayer;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.Comparator;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

import org.json.JSONObject;

import android.util.Log;

import java.nio.FloatBuffer;
import java.nio.LongBuffer;

/**
 * TtsEngine — 离线 Piper TTS 引擎。
 * 运行时：phonemes.json 查英文文本 → 音素名 → 模型 phoneme_id_map 映射为 id
 * （按 Piper 规范输入：^ 句首 + 每音素后跟 _ 分隔 + $ 句尾）→ onnxruntime 合成 22050Hz PCM
 * → 写 WAV 文件 → MediaPlayer 播放（稳定、离线、完整播完）。
 *
 * 不用 AudioTrack 流式播放：它在流式缓冲、提前 stop 上容易丢播/丢尾，几轮整改仍不稳，
 * 改由 MediaPlayer 播放整段 WAV，缓冲/播完由系统处理好。
 */
public class TtsEngine {
  private static final String TAG = "TtsEngine";
  public static final int SAMPLE_RATE = 22050;

  // 音色 → 模型资源名
  private static final String[][] VOICES = {
    {"en-US", "en_US-lessac-medium"},
    {"en-GB", "en_GB-alba-medium"},
  };

  private final Context context;
  private final OrtEnvironment env = OrtEnvironment.getEnvironment();
  private final Map<String, OrtSession> sessions = new ConcurrentHashMap<>();
  private final Map<String, Map<String, Integer>> idMaps = new ConcurrentHashMap<>();

  private volatile Map<String, String[]> phonemesCache = null;
  private final Object phonemesLock = new Object();

  private final ExecutorService exec = Executors.newSingleThreadExecutor();
  private final Object playLock = new Object();
  private final AtomicBoolean stopped = new AtomicBoolean(false);
  private volatile MediaPlayer currentMp = null;

  public TtsEngine(Context context) {
    this.context = context.getApplicationContext();
  }

  // ---------- 通用查询 ----------

  public boolean isAvailable() {
    return true;
  }

  public String[] voices() {
    String[] v = new String[VOICES.length];
    for (int i = 0; i < VOICES.length; i++) v[i] = VOICES[i][0];
    return v;
  }

  public boolean supportsVoice(String voice) {
    for (String[] v : VOICES) if (v[0].equals(voice)) return true;
    return false;
  }

  // ---------- 音素查询 ----------

  private Map<String, String[]> loadPhonemes() {
    synchronized (phonemesLock) {
      if (phonemesCache != null) return phonemesCache;
      Map<String, String[]> map = new ConcurrentHashMap<>();
      try {
        byte[] bytes = readAll(context.getAssets().open("tts/phonemes.json"));
        JSONObject obj = new JSONObject(new String(bytes, "UTF-8"));
        Iterator<String> keys = obj.keys();
        while (keys.hasNext()) {
          String k = keys.next();
          map.put(k, stringArray(obj, k));
        }
      } catch (Exception e) {
        Log.e(TAG, "load phonemes failed", e);
      }
      phonemesCache = map;
      return map;
    }
  }

  private static String[] stringArray(JSONObject obj, String key) {
    try {
      java.util.ArrayList<String> list = new java.util.ArrayList<>();
      org.json.JSONArray a = obj.getJSONArray(key);
      for (int i = 0; i < a.length(); i++) list.add(a.getString(i));
      return list.toArray(new String[0]);
    } catch (Exception e) {
      return new String[0];
    }
  }

  public String[] phonemesOf(String text) {
    Map<String, String[]> map = loadPhonemes();
    if (map == null) return null;
    return map.get(text);
  }

  // ---------- 模型会话 ----------

  private Map<String, Integer> idMapOf(String voice) {
    Map<String, Integer> m = idMaps.get(voice);
    if (m != null) return m;
    String model = modelOf(voice);
    Map<String, Integer> out = new ConcurrentHashMap<>();
    try {
      byte[] bytes = readAll(context.getAssets().open("tts/" + model + ".onnx.json"));
      JSONObject cfg = new JSONObject(new String(bytes, "UTF-8"));
      JSONObject idMapJson = cfg.getJSONObject("phoneme_id_map");
      Iterator<String> keys = idMapJson.keys();
      while (keys.hasNext()) {
        String name = keys.next();
        org.json.JSONArray arr = idMapJson.getJSONArray(name);
        if (arr.length() > 0) out.put(name, arr.getInt(0));
      }
      idMaps.put(voice, out);
    } catch (Exception e) {
      Log.e(TAG, "idMap load failed", e);
    }
    return out;
  }

  private OrtSession sessionOf(String voice) {
    OrtSession s = sessions.get(voice);
    if (s != null) return s;
    String model = modelOf(voice);
    File modelFile = new File(context.getCacheDir(), model + ".onnx");
    try {
      if (!modelFile.exists()) {
        modelFile.getParentFile().mkdirs();
        FileOutputStream fos = new FileOutputStream(modelFile);
        try {
          InputStream is = context.getAssets().open("tts/" + model + ".onnx");
          byte[] buf = new byte[64 * 1024];
          int n;
          while ((n = is.read(buf)) != -1) fos.write(buf, 0, n);
          is.close();
        } finally {
          fos.close();
        }
      }
      OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
      s = env.createSession(modelFile.getAbsolutePath(), opts);
      sessions.put(voice, s);
    } catch (Exception e) {
      Log.e(TAG, "session load failed", e);
    }
    return s;
  }

  private static String modelOf(String voice) {
    for (String[] v : VOICES) if (v[0].equals(voice)) return v[1];
    return VOICES[0][1];
  }

  // ---------- 合成 ----------

  /** 文本 → 22050Hz PCM（float）。失败抛异常。 */
  public float[] synthesize(String voice, String text, float rate, float pitch)
      throws Exception {
    String[] names = phonemesOf(text);
    if (names == null || names.length == 0) {
      throw new IllegalArgumentException("no phonemes for: " + text);
    }
    Map<String, Integer> idMap = idMapOf(voice);
    // Piper 输入序列： [ ^（句首）, _（分隔）] + 每音素 [id, _] + [ $（句尾）]
    Integer hat = idMap.get("^");
    Integer usc = idMap.get("_");
    Integer dol = idMap.get("$");
    int hatId = (hat == null) ? 1 : hat;
    int uscId = (usc == null) ? 0 : usc;
    int dolId = (dol == null) ? 2 : dol;
    java.util.ArrayList<Long> seq = new java.util.ArrayList<>();
    seq.add((long) hatId);
    seq.add((long) uscId);
    for (String n : names) {
      Integer id = idMap.get(n);
      if (id == null) throw new IllegalArgumentException("unknown phoneme: " + n);
      seq.add((long) id);
      seq.add((long) uscId);
    }
    seq.add((long) dolId);
    long[] ids = new long[seq.size()];
    for (int i = 0; i < ids.length; i++) ids[i] = seq.get(i);

    OrtSession session = sessionOf(voice);
    if (session == null) throw new Exception("session not ready");

    Map<String, OnnxTensor> inputs = new ConcurrentHashMap<>();
    try {
      inputs.put("input",
          OnnxTensor.createTensor(env, LongBuffer.wrap(ids), new long[] {1, ids.length}));
      long len = ids.length;
      inputs.put("input_lengths",
          OnnxTensor.createTensor(env, LongBuffer.wrap(new long[] {len}), new long[] {1}));
      float[] scales = {0.667f, rate, pitch * 0.8f};
      inputs.put("scales",
          OnnxTensor.createTensor(env, FloatBuffer.wrap(scales), new long[] {3}));
      Set<String> inNames = session.getInputNames();
      if (inNames != null && inNames.contains("sid")) {
        inputs.put("sid",
            OnnxTensor.createTensor(env, LongBuffer.wrap(new long[] {0}), new long[] {1}));
      }
      OrtSession.Result result = session.run(inputs);
      try {
        OnnxTensor out = null;
        java.util.Optional<OnnxValue> oval = result.get("output");
        if (oval != null && oval.isPresent() && oval.get() instanceof OnnxTensor) {
          out = (OnnxTensor) oval.get();
        }
        if (out == null) {
          Iterator<Map.Entry<String, OnnxValue>> it = result.iterator();
          while (it.hasNext()) {
            OnnxValue v = it.next().getValue();
            if (v instanceof OnnxTensor) { out = (OnnxTensor) v; break; }
          }
        }
        if (out == null) throw new Exception("ort output not found");
        FloatBuffer fb = out.getFloatBuffer();
        float[] audio = new float[fb.remaining()];
        fb.get(audio);
        Log.d(TAG, "synth '" + text + "' " + names.length + " phn -> " + audio.length
            + " smp (~" + String.format("%.2fs", audio.length / (float) SAMPLE_RATE) + ")");
        return audio;
      } finally {
        result.close();
      }
    } finally {
      for (OnnxTensor t : inputs.values()) t.close();
    }
  }

  // ---------- 播放（MediaPlayer + WAV）----------

  /** 后台线程：合成并播放。 */
  public boolean playAsync(final String voice, final String text, final float rate,
      final float pitch) {
    // 关键：新朗读开始前清停止标记（speak() 会先 stop() 打断上一条，若不清标记则本条会被误判为已停止而静音）
    stopped.set(false);
    exec.execute(
        () -> {
          try {
            float[] pcm = synthesize(voice, text, rate, pitch);
            playPcm(pcm);
          } catch (Exception e) {
            Log.e(TAG, "tts failed", e);
          }
        });
    return true;
  }

  private void playPcm(float[] pcm) {
    File wav = new File(context.getCacheDir(), "tts_" + System.currentTimeMillis() + ".wav");
    try {
      writeWav(wav, pcm);
    } catch (Exception e) {
      Log.e(TAG, "write wav failed", e);
      return;
    }
    synchronized (playLock) {
      if (stopped.get()) return;
      stopCurrent();
      try {
        MediaPlayer mp = new MediaPlayer();
        mp.setAudioAttributes(
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
        mp.setDataSource(wav.getAbsolutePath());
        mp.setOnCompletionListener(
            m -> {
              synchronized (playLock) { if (currentMp == m) currentMp = null; }
              try { m.release(); } catch (Exception ignore) {}
            });
        mp.setOnErrorListener(
            (m, what, extra) -> {
              Log.e(TAG, "mediaplayer error what=" + what + " extra=" + extra);
              synchronized (playLock) { if (currentMp == m) currentMp = null; }
              try { m.release(); } catch (Exception ignore) {}
              return true;
            });
        mp.prepare();
        currentMp = mp;
        Log.d(TAG, "play wav=" + wav.getName() + " samples=" + pcm.length);
        mp.start();
      } catch (Exception e) {
        Log.e(TAG, "play wav failed", e);
      }
    }
  }

  /** 停止当前朗读。 */
  public void stop() {
    synchronized (playLock) {
      stopped.set(true);
      stopCurrent();
    }
  }

  private void stopCurrent() {
    MediaPlayer m = currentMp;
    currentMp = null;
    if (m != null) {
      try { m.stop(); } catch (Exception ignore) {}
      try { m.release(); } catch (Exception ignore) {}
    }
  }

  // ---------- 工具 ----------

  private void writeWav(File file, float[] pcm) throws Exception {
    FileOutputStream out = new FileOutputStream(file);
    try {
      byte[] header = wavHeader(pcm.length, SAMPLE_RATE);
      out.write(header);
      byte[] data = new byte[pcm.length * 2];
      for (int i = 0; i < pcm.length; i++) {
        float s = pcm[i];
        if (s > 1f) s = 1f;
        else if (s < -1f) s = -1f;
        int v = (int) (s * 32767);
        data[i * 2] = (byte) (v & 0xFF);
        data[i * 2 + 1] = (byte) ((v >> 8) & 0xFF);
      }
      out.write(data);
    } finally {
      out.close();
    }
  }

  private static byte[] wavHeader(int samples, int rate) {
    int dataSize = samples * 2;
    byte[] h = new byte[44];
    writeAscii(h, 0, "RIFF");
    putIntLE(h, 4, 36 + dataSize);
    writeAscii(h, 8, "WAVE");
    writeAscii(h, 12, "fmt ");
    putIntLE(h, 16, 16);
    putShortLE(h, 20, 1);
    putShortLE(h, 22, 1);
    putIntLE(h, 24, rate);
    putIntLE(h, 28, rate * 2);
    putShortLE(h, 32, 2);
    putShortLE(h, 34, 16);
    writeAscii(h, 36, "data");
    putIntLE(h, 40, dataSize);
    return h;
  }

  private static void writeAscii(byte[] b, int off, String s) {
    for (int i = 0; i < s.length(); i++) b[off + i] = (byte) s.charAt(i);
  }

  private static void putIntLE(byte[] b, int off, int v) {
    b[off] = (byte) (v & 0xFF);
    b[off + 1] = (byte) ((v >> 8) & 0xFF);
    b[off + 2] = (byte) ((v >> 16) & 0xFF);
    b[off + 3] = (byte) ((v >> 24) & 0xFF);
  }

  private static void putShortLE(byte[] b, int off, int v) {
    b[off] = (byte) (v & 0xFF);
    b[off + 1] = (byte) ((v >> 8) & 0xFF);
  }

  private static byte[] readAll(InputStream is) throws Exception {
    java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    int n;
    while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
    is.close();
    return bos.toByteArray();
  }
}
