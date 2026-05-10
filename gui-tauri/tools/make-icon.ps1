Add-Type -AssemblyName System.Drawing
$size = 1024
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

# Rounded square background with gradient using GraphicsPath
$radius = 220
$rect = [System.Drawing.RectangleF]::new(0, 0, $size, $size)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $radius * 2, $radius * 2, 180, 90)
$path.AddArc($size - $radius * 2, 0, $radius * 2, $radius * 2, 270, 90)
$path.AddArc($size - $radius * 2, $size - $radius * 2, $radius * 2, $radius * 2, 0, 90)
$path.AddArc(0, $size - $radius * 2, $radius * 2, $radius * 2, 90, 90)
$path.CloseFigure()

$pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
$pgb.CenterPoint = [System.Drawing.PointF]::new($size / 2, $size * 0.45)
$pgb.CenterColor = [System.Drawing.Color]::FromArgb(255, 255, 126, 182)  # #FF7EB6 neko pink
$pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 31, 24, 48))  # #1F1830 deep purple
$g.FillPath($pgb, $path)

# Soft glow ring
$glowPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(80, 200, 158, 255)), 6
$g.DrawPath($glowPen, $path)

# Paw print (white)
$paw = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(245, 247, 240, 255))

# Main pad
$g.FillEllipse($paw, [single]352, [single]520, [single]320, [single]260)

# Toes in arc (outer left, inner left, inner right, outer right)
$g.FillEllipse($paw, [single]195, [single]340, [single]150, [single]150)
$g.FillEllipse($paw, [single]355, [single]215, [single]170, [single]170)
$g.FillEllipse($paw, [single]499, [single]215, [single]170, [single]170)
$g.FillEllipse($paw, [single]679, [single]340, [single]150, [single]150)

$out = "C:\CloudreveDownloader\gui-tauri\src-tauri\icon-source.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "saved: $out"
