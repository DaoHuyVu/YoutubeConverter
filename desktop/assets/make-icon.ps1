Add-Type -AssemblyName System.Drawing

$OutDir = $PSScriptRoot
$Size = 256
$bmp = New-Object System.Drawing.Bitmap $Size, $Size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

$rect = New-Object System.Drawing.Rectangle 0, 0, $Size, $Size

$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(124, 58, 237),
    [System.Drawing.Color]::FromArgb(219, 39, 119),
    45.0
)

$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 48
$path.AddArc(0, 0, $radius, $radius, 180, 90)
$path.AddArc($Size - $radius, 0, $radius, $radius, 270, 90)
$path.AddArc($Size - $radius, $Size - $radius, $radius, $radius, 0, 90)
$path.AddArc(0, $Size - $radius, $radius, $radius, 90, 90)
$path.CloseFigure()
$g.FillPath($grad, $path)

$noteBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(240, 255, 255, 255))
$noteFont = New-Object System.Drawing.Font 'Segoe UI Symbol', 130, ([System.Drawing.FontStyle]::Regular)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = New-Object System.Drawing.RectangleF 0, -14, $Size, ($Size - 40)
$g.DrawString([char]0x266B, $noteFont, $noteBrush, $textRect, $format)

$labelBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$labelFont = New-Object System.Drawing.Font 'Segoe UI', 34, ([System.Drawing.FontStyle]::Bold)
$labelRect = New-Object System.Drawing.RectangleF 0, ($Size - 78), $Size, 60
$g.DrawString('MP3', $labelFont, $labelBrush, $labelRect, $format)

$pngPath = Join-Path $OutDir 'icon.png'
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Wrote $pngPath"

$sizes = @(256, 128, 64, 48, 32, 16)
$pngBytesList = @()
foreach ($s in $sizes) {
    $resized = New-Object System.Drawing.Bitmap $s, $s
    $rg = [System.Drawing.Graphics]::FromImage($resized)
    $rg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $rg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $rg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $rg.DrawImage($bmp, 0, 0, $s, $s)
    $rg.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $resized.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytesList += ,@($s, $ms.ToArray())
    $resized.Dispose()
    $ms.Dispose()
}

$icoPath = Join-Path $OutDir 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter $fs

$count = $pngBytesList.Count
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$count)

$headerSize = 6 + $count * 16
$offset = $headerSize
foreach ($entry in $pngBytesList) {
    $size = $entry[0]
    $bytes = $entry[1]
    $byteSize = if ($size -eq 256) { [Byte]0 } else { [Byte]$size }
    $bw.Write([Byte]$byteSize)
    $bw.Write([Byte]$byteSize)
    $bw.Write([Byte]0)
    $bw.Write([Byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]$bytes.Length)
    $bw.Write([UInt32]$offset)
    $offset += $bytes.Length
}
foreach ($entry in $pngBytesList) {
    $bw.Write($entry[1])
}
$bw.Close()
$fs.Close()
Write-Host "Wrote $icoPath"

$g.Dispose()
$bmp.Dispose()
