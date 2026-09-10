package top.cloudgenshin.wordexcite;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // v1.19.0：导出备份的原生“保存到…”文件选择插件
    registerPlugin(SaveDocument.class);
    // v1.20.0：离线本地 TTS（Piper + onnxruntime）
    registerPlugin(TTSPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
