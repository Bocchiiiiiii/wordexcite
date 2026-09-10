# 重新生成本地打包的 ts-fsrs 浏览器构建
# 用法（PowerShell）：.\scripts\copy-fsrs-vendor.ps1
# 前置：npm install（node_modules/ts-fsrs 存在）
$ErrorActionPreference = 'Stop'
$src = 'node_modules\ts-fsrs\dist\index.umd.js'
$license = 'node_modules\ts-fsrs\LICENSE'
$destDir = 'shared\vendor'
$dest = Join-Path $destDir 'ts-fsrs-5.4.1.js'

if (-not (Test-Path $src)) { throw '未找到 node_modules\ts-fsrs，请先 npm install' }
if (-not (Test-Path $license)) { throw '未找到 ts-fsrs LICENSE' }

New-Item -ItemType Directory -Force -Path $destDir | Out-Null
$code = Get-Content $src -Raw
# 去掉 sourceMappingURL 引用，避免 404
$code = $code -replace '(?s)\s*//# sourceMappingURL=.*$', ''
$lic = Get-Content $license -Raw
$header = "/*! ts-fsrs 5.4.1 (UMD build, bundled locally)`n" +
          ($lic -replace '(?m)^', ' * ') + " */`n"
Set-Content -Path $dest -Value ($header + "`n" + $code) -Encoding UTF8
Write-Output "已生成 $dest"
