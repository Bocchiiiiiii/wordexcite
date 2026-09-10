# Generate favicon.ico (32x32 PNG inside ICO) from a source PNG.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\gen-favicon.ps1 <src.png>
# Also writes icons\icon-32.png (32x32 resize of the source).
# Pure ASCII (no non-ASCII comments) so PS 5.1 parses safely on zh-CN Windows.
param([string]$Src)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\icons'
$img = [System.Drawing.Image]::FromFile((Resolve-Path $Src))

# 32x32 PNG
$bmp32 = New-Object System.Drawing.Bitmap(32, 32)
$g = [System.Drawing.Graphics]::FromImage($bmp32)
try {
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, 32, 32)))
} finally {
  $g.Dispose()
  $img.Dispose()
}
$bmp32.Save((Join-Path $outDir 'icon-32.png'), [System.Drawing.Imaging.ImageFormat]::Png)

# Wrap the 32x32 PNG into an ICO container (single PNG-embedded entry).
function Save-PngAsIco {
  param([System.Drawing.Bitmap]$Bitmap, [string]$OutFile)
  $ms = New-Object System.IO.MemoryStream
  $bmpSave = New-Object System.Drawing.Bitmap(32, 32)   # ensure 32x32
  $gs = [System.Drawing.Graphics]::FromImage($bmpSave)
  try {
    $gs.DrawImage($Bitmap, 0, 0, 32, 32)
  } finally { $gs.Dispose() }
  $bmpSave.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes = $ms.ToArray()
  $ms.Dispose()
  $bmpSave.Dispose()

  $ico = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ico)
  $bw.Write([uint16]0)                  # ICONDIR.reserved
  $bw.Write([uint16]1)                  # ICONDIR.type = 1 (icon)
  $bw.Write([uint16]1)                  # ICONDIR.count = 1
  $bw.Write([byte]32)                   # width
  $bw.Write([byte]32)                   # height
  $bw.Write([byte]0)                    # colorCount = 0
  $bw.Write([byte]0)                    # reserved
  $bw.Write([uint16]1)                  # planes
  $bw.Write([uint16]32)                 # bitCount
  $bw.Write([uint32]$pngBytes.Length)   # bytesInRes
  $bw.Write([uint32]22)                 # imageOffset = 6 + 16
  $bw.Write($pngBytes)
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($OutFile, $ico.ToArray())
  $bw.Dispose()
  $ico.Dispose()
}

Save-PngAsIco $bmp32 (Join-Path $outDir 'favicon.ico')
$bmp32.Dispose()
Write-Output "generated $(Join-Path $outDir 'favicon.ico') and icon-32.png from $Src"