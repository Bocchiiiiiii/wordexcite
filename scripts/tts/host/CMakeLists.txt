cmake_minimum_required(VERSION 3.16)
project(tts_phonemize LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(MSVC)
  # piper 音素 / phoneme_ids.hpp 含 UTF-8 常量，MSVC 需 UTF-8 编译
  add_compile_options("/utf-8")
endif()

# piper-phonemize 源码目录（含 phonemize/shared/phoneme_ids/*.hpp/json.hpp/uni_algo.h）
if(NOT DEFINED PIPER_SRC)
  set(PIPER_SRC "D:/tmp/piper-host/piper-phonemize-master/src")
endif()
# espeak-ng 安装前缀（编译好 espeak-ng 后 install 到该前缀）
if(NOT DEFINED ESPEAK_NG_DIR)
  set(ESPEAK_NG_DIR "D:/tmp/piper-host/ei")
endif()

# 精简核心：只做音素化，不包含 tashkeel / onnxruntime
add_library(tts_phonemize_core STATIC
  ${PIPER_SRC}/phonemize.cpp
  ${PIPER_SRC}/shared.cpp
  ${PIPER_SRC}/phoneme_ids.cpp
)
target_include_directories(tts_phonemize_core PUBLIC
  ${PIPER_SRC}
  ${ESPEAK_NG_DIR}/include
)
target_link_directories(tts_phonemize_core PUBLIC ${ESPEAK_NG_DIR}/lib)
target_link_libraries(tts_phonemize_core PUBLIC espeak-ng)

add_executable(tts_phonemize src/main.cpp)
target_include_directories(tts_phonemize PRIVATE ${PIPER_SRC} ${ESPEAK_NG_DIR}/include)
target_link_libraries(tts_phonemize PRIVATE tts_phonemize_core)
