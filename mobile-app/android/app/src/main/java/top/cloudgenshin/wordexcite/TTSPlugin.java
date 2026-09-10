package top.cloudgenshin.wordexcite;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * TTSPlugin — 离线本地 TTS 的 Capacitor 桥（speak/stop/synthesize/isAvailable）。
 * 运行时用 onnxruntime 合成 Piper 语音并本地播放，完全离线。
 */
@CapacitorPlugin(name = "TTS")
public class TTSPlugin extends Plugin {

  private TtsEngine engine;

  private TtsEngine engine() {
    if (engine == null) engine = new TtsEngine(getContext());
    return engine;
  }

  /** 朗读文本。参数：text, voice(en-US|en-GB), rate(0.5-2), pitch(0.5-2)。 */
  @PluginMethod
  public void speak(PluginCall call) {
    String text = call.getString("text", "");
    if (text == null || text.isEmpty()) {
      call.reject("text is required");
      return;
    }
    String voice = call.getString("voice", "en-US");
    if (!engine().supportsVoice(voice)) voice = "en-US";
    double rateD = call.getDouble("rate", 1.0);
    double pitchD = call.getDouble("pitch", 1.0);
    float rate = (float) rateD;
    float pitch = (float) pitchD;
    if (rate <= 0) rate = 1;
    if (pitch <= 0) pitch = 1;
    engine().stop();
    engine().playAsync(voice, text, rate, pitch);
    call.resolve();
  }

  /** 停止当前朗读。 */
  @PluginMethod
  public void stop(PluginCall call) {
    engine().stop();
    call.resolve();
  }

  /** 是否存在该文本的音素（离线是否可读）。可用于回退判断。 */
  @PluginMethod
  public void hasPhonemes(PluginCall call) {
    String text = call.getString("text", "");
    boolean ok = text != null && engine().phonemesOf(text) != null;
    JSObject ret = new JSObject();
    ret.put("available", ok);
    call.resolve(ret);
  }

  /** 插件是否可用 + 支持的音色。 */
  @PluginMethod
  public void isAvailable(PluginCall call) {
    JSObject ret = new JSObject();
    ret.put("available", engine().isAvailable());
    ret.put("voices", engine().voices());
    call.resolve(ret);
  }
}
