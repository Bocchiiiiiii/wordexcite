@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >NUL
set "BT=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools"
set "CMAKE=%BT%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
set "NINJA=%BT%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja"
set "PATH=%CMAKE%;%NINJA%;%PATH%"

set "PIPER_SRC=D:\tmp\piper-host\piper-phonemize-master\src"
set "ESPEAK_NG_DIR=D:\tmp\piper-host\ei"

if exist host-build rmdir /s/q host-build
"%CMAKE%" -S D:\Coding\Enexcite\scripts\tts\host -B host-build -G Ninja -DCMAKE_BUILD_TYPE=Release -DPIPER_SRC=%PIPER_SRC% -DESPEAK_NG_DIR=%ESPEAK_NG_DIR%
if errorlevel 1 exit /b 1
"%CMAKE%" --build host-build
if errorlevel 1 exit /b 2
echo HOST_BUILD_OK
