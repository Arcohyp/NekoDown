#Requires -Version 5.1

class DownloaderLogger {
    [string]$LogFile
    [bool]$Enabled

    DownloaderLogger([string]$logDir, [bool]$enabled) {
        $this.Enabled = $enabled
        if ($enabled) {
            $date = Get-Date -Format "yyyy-MM-dd"
            $this.LogFile = Join-Path $logDir "download-$date.log"
            if (-not (Test-Path $logDir)) {
                New-Item -ItemType Directory -Path $logDir -Force | Out-Null
            }
        }
    }

    [void]Write([string]$level, [string]$message) {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $line = "[$timestamp] [$level] $message"
        if ($this.Enabled -and $this.LogFile) {
            Add-Content -Path $this.LogFile -Value $line -ErrorAction SilentlyContinue
        }
    }

    [void]Info([string]$msg)    { $this.Write("INFO",    $msg) }
    [void]Warn([string]$msg)    { $this.Write("WARN",    $msg) }
    [void]Error([string]$msg)   { $this.Write("ERROR",   $msg) }
    [void]Success([string]$msg) { $this.Write("SUCCESS", $msg) }
}

# Console UI helpers. Used by core.ps1 and the CLI entry. The GUI launcher
# can run hidden so these are invisible there, but they still feed $script:Logger.
function Write-Info {
    param([string]$msg)
    Write-Host "[INFO] $msg" -ForegroundColor Cyan
    if ($script:Logger) { $script:Logger.Info($msg) }
}
function Write-Success {
    param([string]$msg)
    Write-Host "[OK]   $msg" -ForegroundColor Green
    if ($script:Logger) { $script:Logger.Success($msg) }
}
function Write-Warn {
    param([string]$msg)
    Write-Host "[WARN] $msg" -ForegroundColor Yellow
    if ($script:Logger) { $script:Logger.Warn($msg) }
}
function Write-Err {
    param([string]$msg)
    Write-Host "[ERR]  $msg" -ForegroundColor Red
    if ($script:Logger) { $script:Logger.Error($msg) }
}

# Single-line progress bar in the console. Default rendering for CLI.
# GUI passes its own OnProgress callback to Start-FileDownload and ignores this.
function Show-Progress {
    param(
        [long]$Current,
        [long]$Total,
        [long]$Speed,
        [string]$FileName
    )
    if ($Total -le 0) {
        $percent = if ($Current -gt 0) { 100 } else { 0 }
    } else {
        $percent = [math]::Min(100, [math]::Round(($Current / $Total) * 100, 1))
    }
    $barWidth = 40
    $filled = [math]::Round($barWidth * $percent / 100)
    $empty = $barWidth - $filled
    $bar = ("=" * $filled) + ("-" * $empty)
    $sizeStr = "$(Format-Size -size $Current) / $(Format-Size -size $Total)"
    $speedStr = Format-Speed -bytesPerSec $Speed
    Write-Host "`r[$bar] $percent% | $sizeStr | $speedStr | $FileName" -NoNewline -ForegroundColor Cyan
}
