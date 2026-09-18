package top.cloudgenshin.wordexcite;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * SaveDocument — 导出备份用原生“保存到…”文件选择（ACTION_CREATE_DOCUMENT）。
 * 点击导出时由 JS 传入 { fileName, mimeType, data(base64) }，
 * 系统弹出文件保存页让用户选位置，写入后 resolve，取消则 reject。
 *
 * v1.27.0 修闪退（TransactionTooLargeException）：
 *   备份含全部 AI 知识缓存，base64 后实测 24MB。Capacitor 的 Bridge.saveInstanceState()
 *   会把「最后一次启动 Activity 的 PluginCall 选项」整份写进 savedInstanceState，
 *   而 Binder 事务上限约 1MB —— 打开系统文件页那一瞬间就抛
 *   TransactionTooLargeException（data parcel size 48881636 bytes）→ 进程直接挂掉。
 *   修法（Capacitor 官方建议的同一条路）：
 *     ① 大字段不进 PluginCall：先落私有缓存文件，然后 call.getData().remove("data")；
 *     ② 覆写 saveInstanceState()/restoreState()，只持久化那个临时文件路径；
 *     ③ 写目标文件时从临时文件流式拷贝，完成后删掉临时文件。
 */
@CapacitorPlugin(name = "SaveDocument")
public class SaveDocument extends Plugin {

  private static final String STATE_PAYLOAD_PATH = "saveDocumentPayloadPath";
  private static final String TEMP_PREFIX = "export-payload-";
  private static final String TEMP_SUFFIX = ".tmp";
  private static final int COPY_BUFFER = 64 * 1024;

  private File payloadFile;

  @PluginMethod
  public void save(PluginCall call) {
    String fileName = call.getString("fileName", "backup.json");
    String mimeType = call.getString("mimeType", "application/json");
    String data = call.getString("data", "");

    File tmp = null;
    try {
      cleanupStalePayloads();
      tmp = File.createTempFile(TEMP_PREFIX, TEMP_SUFFIX, getContext().getCacheDir());
      byte[] bytes = Base64.decode(data, Base64.DEFAULT);
      FileOutputStream fos = new FileOutputStream(tmp);
      try {
        fos.write(bytes);
        fos.flush();
      } finally {
        try { fos.close(); } catch (IOException ignored) {}
      }
      payloadFile = tmp;
    } catch (Exception e) {
      if (tmp != null) { try { tmp.delete(); } catch (Exception ignored) {} }
      payloadFile = null;
      call.reject("导出内容写入缓存失败：" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
      return;
    }

    /* 关键一步：把大字段从 PluginCall 上摘掉。
       Capacitor 的 saveInstanceState 会把 call.getData().toString() 塞进 Bundle，
       留着这 24MB 就会重现闪退。 */
    try { call.getData().remove("data"); } catch (Exception ignored) {}

    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType(mimeType != null ? mimeType : "application/octet-stream");
    intent.putExtra(Intent.EXTRA_TITLE, fileName != null ? fileName : "backup.json");

    startActivityForResult(call, intent, "createDocumentResult");
  }

  /** 只持久化临时文件路径（几十字节），不再把整份导出内容写进 Bundle。 */
  @Override
  protected Bundle saveInstanceState() {
    Bundle state = new Bundle();
    if (payloadFile != null) state.putString(STATE_PAYLOAD_PATH, payloadFile.getAbsolutePath());
    return state;
  }

  @Override
  protected void restoreState(Bundle state) {
    if (state == null) return;
    String path = state.getString(STATE_PAYLOAD_PATH);
    if (path != null && path.length() > 0) payloadFile = new File(path);
  }

  @ActivityCallback
  private void createDocumentResult(PluginCall call, ActivityResult result) {
    if (call == null) return;
    if (result == null || result.getResultCode() != Activity.RESULT_OK) {
      cleanupPayload();
      call.reject("用户取消了保存");
      return;
    }
    Uri uri = result.getData() != null ? result.getData().getData() : null;
    if (uri == null) {
      cleanupPayload();
      call.reject("未获取到目标文件");
      return;
    }
    File src = payloadFile;
    if (src == null || !src.isFile() || src.length() == 0) {
      cleanupPayload();
      call.reject("导出内容已失效，请重新导出");
      return;
    }
    try {
      OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wt");
      if (os == null) {
        cleanupPayload();
        call.reject("无法打开目标文件");
        return;
      }
      try {
        InputStream in = new FileInputStream(src);
        try {
          byte[] buf = new byte[COPY_BUFFER];
          int n;
          while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
          os.flush();
        } finally {
          try { in.close(); } catch (IOException ignored) {}
        }
      } finally {
        try { os.close(); } catch (IOException ignored) {}
      }
      JSObject ret = new JSObject();
      ret.put("path", uri.toString());
      ret.put("bytes", src.length());
      call.resolve(ret);
    } catch (IOException e) {
      call.reject("写入失败：" + e.getMessage());
    } finally {
      cleanupPayload();
    }
  }

  private void cleanupPayload() {
    File f = payloadFile;
    payloadFile = null;
    if (f != null) { try { f.delete(); } catch (Exception ignored) {} }
  }

  /* 上次导出中途被杀会留下临时文件，启动新一轮导出前顺手清掉 */
  private void cleanupStalePayloads() {
    try {
      File dir = getContext().getCacheDir();
      File[] files = dir.listFiles();
      if (files == null) return;
      for (File f : files) {
        String name = f.getName();
        if (name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX)) {
          if (payloadFile == null || !f.getAbsolutePath().equals(payloadFile.getAbsolutePath())) {
            try { f.delete(); } catch (Exception ignored) {}
          }
        }
      }
    } catch (Exception ignored) {}
  }
}
