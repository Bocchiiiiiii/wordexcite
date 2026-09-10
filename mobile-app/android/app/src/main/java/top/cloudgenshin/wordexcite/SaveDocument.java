package top.cloudgenshin.wordexcite;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.io.OutputStream;

/**
 * SaveDocument — 导出备份用原生“保存到…”文件选择（ACTION_CREATE_DOCUMENT）。
 * 点击导出时由 JS 传入 { fileName, mimeType, data(base64) }，
 * 系统弹出文件保存页让用户选位置，写入后 resolve，取消则 reject。
 */
@CapacitorPlugin(name = "SaveDocument")
public class SaveDocument extends Plugin {

  @PluginMethod
  public void save(PluginCall call) {
    String fileName = call.getString("fileName", "backup.json");
    String mimeType = call.getString("mimeType", "application/json");
    String data = call.getString("data", "");

    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType(mimeType != null ? mimeType : "application/octet-stream");
    intent.putExtra(Intent.EXTRA_TITLE, fileName != null ? fileName : "backup.json");

    startActivityForResult(call, intent, "createDocumentResult");
  }

  @ActivityCallback
  private void createDocumentResult(PluginCall call, ActivityResult result) {
    if (call == null) return;
    if (result == null || result.getResultCode() != Activity.RESULT_OK) {
      call.reject("用户取消了保存");
      return;
    }
    Uri uri = result.getData() != null ? result.getData().getData() : null;
    if (uri == null) {
      call.reject("未获取到目标文件");
      return;
    }
    String data = call.getString("data", "");
    byte[] bytes;
    try {
      bytes = Base64.decode(data, Base64.DEFAULT);
    } catch (Exception e) {
      call.reject("base64 解码失败：" + e.getMessage());
      return;
    }
    try {
      OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wt");
      if (os == null) {
        call.reject("无法打开目标文件");
        return;
      }
      try {
        os.write(bytes);
      } finally {
        try { os.close(); } catch (IOException ignored) {}
      }
      JSObject ret = new JSObject();
      ret.put("path", uri.toString());
      call.resolve(ret);
    } catch (IOException e) {
      call.reject("写入失败：" + e.getMessage());
    }
  }
}
