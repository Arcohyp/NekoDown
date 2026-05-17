#Requires -Version 5.1

<#
.SYNOPSIS
    NekoDown CLI entry. The console download flow for Cloudreve shares.

.DESCRIPTION
    Auto-parse Cloudreve v4 share links and download with aria2 multi-threading.
    Supports single files and folder shares.

    All shared logic lives under lib/* and is re-used by neko-down-gui.ps1.

.PARAMETER ShareLink
    Cloudreve share link (optional, will prompt if not provided).

.PARAMETER OutputDir
    Download directory (overrides config).

.PARAMETER Aria2Connections
    aria2 connection count (overrides config).

.EXAMPLE
    .\neko-down.ps1

.EXAMPLE
    .\neko-down.ps1 -ShareLink "https://pan.nekogal.top/s/yE4u7"
#>

[CmdletBinding()]
param(
    [string]$ShareLink = "",
    [string]$OutputDir = "",
    [int]$Aria2Connections = 0
)

$script:Version = "3.4.0"
$script:BaseDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $script:BaseDir) { $script:BaseDir = (Get-Location).Path }
$script:ConfigPath = Join-Path $script:BaseDir "config.json"
$script:LogDir = Join-Path $script:BaseDir "logs"
$script:TempDir = Join-Path $script:BaseDir "temp"
$script:Config = $null
$script:ActiveDownloads = @()
$script:Logger = $null
$script:Aria2Path = $null

$ErrorActionPreference = "Stop"

# Console encoding (so UTF-8 file names render correctly).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Host "[ERR]  PowerShell 5.1 or higher required. Current: $($PSVersionTable.PSVersion)" -ForegroundColor Red
    exit 1
}

# Shared library
. "$PSScriptRoot\lib\log.ps1"
. "$PSScriptRoot\lib\i18n.ps1"
. "$PSScriptRoot\lib\core.ps1"

# ==================== CLI-only helpers ====================
function Register-ExitHandler {
    try { [Console]::TreatControlCAsInput = $true } catch { }
}

function Check-Interrupt {
    try {
        if ([Console]::KeyAvailable) {
            $key = [Console]::ReadKey($true)
            if ($key.Key -eq "C" -and $key.Modifiers -eq "Control") {
                Write-Host ""
                Write-Warn "Interrupted by user (Ctrl+C)"
                Cleanup-TempFiles
                exit 130
            }
        }
    } catch { }
}

# ==================== Main ====================
try {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Magenta
    Write-Host "  NekoDown v$script:Version" -ForegroundColor Magenta
    Write-Host "========================================" -ForegroundColor Magenta
    Write-Host ""

    Load-Config
    Register-ExitHandler

    if (-not (Test-Aria2Installed)) {
        if (-not (Install-Aria2)) {
            Write-Err (L "aria2_install_failed")
            exit 1
        }
    }
    Write-Success (L "aria2_ready")

    if (-not $OutputDir) { $OutputDir = $script:Config.defaultOutputDir }
    if ($Aria2Connections -eq 0) { $Aria2Connections = $script:Config.defaultConnections }

    if (-not $ShareLink) {
        Write-Host (L "parse_link") -ForegroundColor Cyan
        Write-Host "  $(L "example_standard")" -ForegroundColor Gray
        Write-Host "  $(L "example_pan_home")" -ForegroundColor Gray
        Write-Host "  $(L "example_share_home")" -ForegroundColor Gray
        $ShareLink = Read-Host "Link"
    }
    if (-not $ShareLink) { Write-Err (L "no_link"); exit 1 }

    $parsed = Parse-ShareLink -link $ShareLink
    if (-not $parsed) { Write-Err (L "invalid_link"); exit 1 }
    $shareId = $parsed.ShareId
    $domain = $parsed.Domain
    Write-Info "$(L "share_id"): $shareId"
    Write-Info "$(L "domain"): $domain"
    Write-Host ""

    Write-Info (L "parsing_link")
    $info = Get-ShareInfo -shareId $shareId -domain $domain
    if ($info) {
        Write-Host "$(L "name"):      $($info.name)" -ForegroundColor White
        Write-Host "$(L "owner"):     $($info.owner.nickname)" -ForegroundColor White
        Write-Host "$(L "views"):     $($info.visited)" -ForegroundColor White
        Write-Host "$(L "downloads"): $($info.downloaded)" -ForegroundColor White
        Write-Host ""
    } else {
        Write-Warn (L "share_info_failed")
    }

    Write-Info (L "parsing_link")
    $files = Expand-FileList -shareId $shareId -domain $domain
    if (-not $files -or $files.Count -eq 0) { Write-Err (L "no_files_found"); exit 1 }

    if ($files.Count -eq 1) {
        $selected = @($files[0])
        Write-Success (L "single_file_auto")
        Write-Host "  [$(L "file_label")] $($files[0].name) ($(Format-Size -size $files[0].size))" -ForegroundColor White
        Write-Host ""
    } else {
        Write-Host ""
        Write-Host "$(L "file_list") ($($files.Count))" -ForegroundColor Cyan
        Write-Host ""
        for ($i = 0; $i -lt $files.Count; $i++) {
            $f = $files[$i]
            $displayName = if ($f._relativePath) { "$($f._relativePath)/$($f.name)" } else { $f.name }
            Write-Host "  [$($i+1)] [$(L "file_label")] $displayName ($(Format-Size -size $f.size))" -ForegroundColor White
        }
        Write-Host ""
        $sel = Read-Host (L "select_files")
        if ($sel -eq "all") { $selected = $files }
        else {
            $idx = $sel -split "," | ForEach-Object { $_.Trim() -as [int] } | Where-Object { $_ -gt 0 -and $_ -le $files.Count }
            $selected = $idx | ForEach-Object { $files[$_ - 1] }
        }
    }

    if (-not $selected -or $selected.Count -eq 0) { Write-Err (L "no_files_selected"); exit 1 }

    Write-Host ""
    Write-Success (L "selected_count" -f $selected.Count)
    Write-Host ""

    if (-not (Test-Path $OutputDir)) {
        New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
        Write-Info "$(L "created_output") $OutputDir"
    }

    $totalSize = 0
    foreach ($f in $selected) { $totalSize += $f.size }
    if (-not (Test-DiskSpace -requiredBytes $totalSize -path $OutputDir)) { exit 1 }

    $success = 0
    $failed = 0
    foreach ($file in $selected) {
        $name = Sanitize-FileName -name $file.name
        $uri = $file.path
        $relativePath = $file._relativePath

        $targetDir = $OutputDir
        if ($relativePath) {
            $subDirs = $relativePath -split "/" | ForEach-Object { Sanitize-FileName -name $_ }
            $sanitizedRelativePath = $subDirs -join "\"
            $targetDir = Join-Path $OutputDir $sanitizedRelativePath
            if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
        }
        $out = Join-Path $targetDir $name
        $displayName = if ($relativePath) { "$relativePath/$($file.name)" } else { $file.name }

        Write-Host "----------------------------------------" -ForegroundColor Gray
        Write-Info "$(L "file"): $displayName"
        Write-Info "$(L "size"): $(Format-Size -size $file.size)"
        Write-Host ""

        if (Test-Path $out) {
            $es = (Get-Item $out).Length
            if ($es -eq $file.size) {
                Write-Success (L "already_exists")
                $success++
                continue
            }
            Write-Warn (L "exists_overwrite")
            Remove-Item $out -Force
        }

        $retry = 0
        $maxRetry = $script:Config.maxRetries
        $done = $false
        while ($retry -lt $maxRetry -and -not $done) {
            if ($retry -gt 0) { Write-Info (L "retrying" -f $retry, $maxRetry) }
            $url = Get-DownloadUrl -fileUri $uri -domain $domain
            if (-not $url) {
                Write-Err (L "cannot_get_url")
                $retry++
                if ($retry -lt $maxRetry) { Start-Sleep -Seconds 3 }
                continue
            }
            $code = Start-FileDownload -url $url -outPath $out -fileSize $file.size -conn $Aria2Connections -domain $domain
            if ($code -eq 0 -and (Test-Path $out) -and (Get-Item $out).Length -eq $file.size) {
                Write-Success "$(L "download_completed"): $displayName"
                $success++
                $done = $true
            } else {
                $retry++
                if ($retry -lt $maxRetry) {
                    Write-Info (L "waiting_retry")
                    Start-Sleep -Seconds 5
                }
            }
        }
        if (-not $done) {
            Write-Err (L "failed_after_retries" -f $maxRetry)
            $failed++
        }
        Write-Host ""
    }

    Write-Host "========================================" -ForegroundColor Magenta
    if ($success -eq $selected.Count) {
        Write-Success "$(L "all_done") ($success/$($selected.Count))"
    } else {
        Write-Warn (L "completed_summary" -f $success, $failed)
    }
    Write-Info "$(L "location"): $(Resolve-Path $OutputDir)"
    if ($script:Config.logEnabled) {
        Write-Info "$(L "log_location"): $($script:Logger.LogFile)"
    }
    Write-Host "========================================" -ForegroundColor Magenta
    Write-Host ""

    Cleanup-TempFiles

} catch {
    Write-Host ""
    Write-Err "$(L "error_occurred"): $_"
    Write-Host ""
    Write-Host (L "stack_trace") -ForegroundColor DarkGray
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    Write-Host ""
} finally {
    Write-Host ""
    Write-Host (L "press_any_key") -ForegroundColor Gray
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}
