# Resize a source PNG to a target square size using System.Drawing.
param(
  [string]$Src,
  [string]$Dst,
  [int]$Size
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$img = [System.Drawing.Image]::FromFile((Resolve-Path $Src))
$bmp = New-Object System.Drawing.Bitmap($Size, $Size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $rect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
  $g.DrawImage($img, $rect)
} finally {
  $g.Dispose()
  $img.Dispose()
}
$bmp.Save((Join-Path (Split-Path $Dst -Parent) (Split-Path $Dst -Leaf)), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "resized $Dst ($($Size)x$($Size))"