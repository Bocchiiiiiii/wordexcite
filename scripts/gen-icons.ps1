# Generate PWA install icons and site favicon.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\gen-icons.ps1
# Design: dark #181a1d rounded square + gold #ffd76a Han character "ci" (Microsoft YaHei).
# Outputs icons\icon-192.png, icon-512.png, icon-512-maskable.png, icon-32.png,
# and icons\favicon.ico (32x32 PNG embedded in ICO). The favicon stops the browser's
# auto-request /favicon.ico 404 noise on every page load.
#
# NOTE: keep this file pure ASCII (English comments only). On zh-CN Windows,
# PowerShell 5.1 reads BOM-less .ps1 as ANSI/GBK, so non-ASCII corrupts parsing.
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$bgColor = [System.Drawing.ColorTranslator]::FromHtml('#181a1d')
$gold    = [System.Drawing.ColorTranslator]::FromHtml('#ffd76a')
$glyph   = [string][char]0x8BCD

function Get-GlyphFont {
  param([float]$EmSize)
  foreach ($name in @('Microsoft YaHei', 'Microsoft YaHei UI', 'SimHei', 'SimSun', 'Arial')) {
    try {
      $f = New-Object System.Drawing.Font($name, $EmSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
      if ($f.Name -eq $name) { return $f }
      $f.Dispose()
    } catch { }
  }
  throw 'No CJK-capable font was found'
}

function New-RoundedRectPath {
  param([float]$X, [float]$Y, [float]$W, [float]$H, [float]$R)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $R * 2
  $p.AddArc($X, $Y, $d, $d, 180, 90)
  $p.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
  $p.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
  $p.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-Icon {
  param([int]$Size, [float]$CornerPct, [float]$GlyphBoxPct, [string]$OutFile)
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $bgBrush = New-Object System.Drawing.SolidBrush($bgColor)
    if ($CornerPct -gt 0) {
      $r = [float]($Size * $CornerPct / 100)
      $path = New-RoundedRectPath 0 0 $Size $Size $r
      $g.FillPath($bgBrush, $path)
      $path.Dispose()
    } else {
      $g.FillRectangle($bgBrush, 0, 0, $Size, $Size)
    }
    $box = [float]($Size * $GlyphBoxPct)
    $x = [float](($Size - $box) / 2)
    $y = $x
    $font = Get-GlyphFont ([float](($Size * $GlyphBoxPct) * 1.12))
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $goldBrush = New-Object System.Drawing.SolidBrush($gold)
    $g.DrawString($glyph, $font, $goldBrush, (New-Object System.Drawing.RectangleF($x, $y, $box, $box)), $sf)
    $goldBrush.Dispose()
    $font.Dispose()
    $sf.Dispose()
    $bgBrush.Dispose()
  } finally {
    $g.Dispose()
  }
  $out = Join-Path $outDir $OutFile
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "generated $out ($($Size)x$($Size))"
}

New-Icon 192 22 0.56 'icon-192.png'
New-Icon 512 22 0.56 'icon-512.png'
New-Icon 512 0 0.52 'icon-512-maskable.png'
New-Icon 32 22 0.56 'icon-32.png'

# Wrap the 32x32 PNG into an ICO container (single PNG-embedded entry).
$pngBytes = [System.IO.File]::ReadAllBytes((Join-Path $outDir 'icon-32.png'))
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
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
[System.IO.File]::WriteAllBytes((Join-Path $outDir 'favicon.ico'), $ms.ToArray())
$bw.Dispose()
$ms.Dispose()
Write-Output "generated $(Join-Path $outDir 'favicon.ico') (32x32)"