// Host 端音素化工具：读入英文文本，用 piper-phonemize 输出 piper 音素名序列。
// 用途：在“构建机”上把知识库全部单词+例句预计算成音素 JSON，
// 打包给 App 运行时用 onnxruntime 合成语音（App 内无需 espeak-ng/WASM）。
//
// 用法：
//   tts_phonemize [--espeak_data DIR] [--language en-us]
// 从 stdin 读取，每行一条文本（或 {"text":"..."} JSON），输出 JSONL：
//   {"text": "...", "phonemes": ["AH", "P", ...]}
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

#include <espeak-ng/speak_lib.h>

#include "json.hpp"
#include "phonemize.hpp"
#include "uni_algo.h"

namespace {
std::string nameOf(const piper::Phoneme &ph) {
  std::u32string u;
  u += ph;
  return una::utf32to8(u);
}
} // namespace

int main(int argc, char *argv[]) {
  std::string espeakData;
  std::string language = "en-us";

  for (int i = 1; i < argc; i++) {
    if (!std::strcmp(argv[i], "--espeak_data") || !std::strcmp(argv[i], "--espeak-data")) {
      if (i + 1 < argc) espeakData = argv[++i];
    } else if (!std::strcmp(argv[i], "--language") || !std::strcmp(argv[i], "-l")) {
      if (i + 1 < argc) language = argv[++i];
    }
  }
  if (espeakData.empty()) {
    std::cerr << "--espeak_data is required" << std::endl;
    return 1;
  }

  piper::eSpeakPhonemeConfig cfg;
  cfg.voice = language;
  int sampleRate =
      espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, espeakData.c_str(), 0);
  if (sampleRate < 0) {
    std::cerr << "Failed to initialize eSpeak (" << sampleRate << ")" << std::endl;
    return 2;
  }

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    nlohmann::json in;
    if (!line.empty() && line[0] == '{') {
      try {
        in = nlohmann::json::parse(line);
      } catch (...) {
        in = nlohmann::json{{"text", line}};
      }
    } else {
      in = nlohmann::json{{"text", line}};
    }
    const std::string text = in.value("text", line);

    nlohmann::json out;
    out["text"] = text;
    out["phonemes"] = nlohmann::json::array();
    try {
      std::vector<std::vector<piper::Phoneme>> parsed;
      piper::phonemize_eSpeak(text, cfg, parsed);
      for (const auto &sentence : parsed) {
        for (const auto &ph : sentence) {
          out["phonemes"].push_back(nameOf(ph));
        }
      }
    } catch (const std::exception &e) {
      out["error"] = e.what();
    }
    std::cout << out.dump() << std::endl;
  }

  espeak_Terminate();
  return 0;
}
