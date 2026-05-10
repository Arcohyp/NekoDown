#Requires -Version 5.1

<#
.SYNOPSIS
    NekoDown PowerShell bridge for the Tauri GUI.
.DESCRIPTION
    Two actions: "parse" returns a single JSON document with the share's file
    list; "download" streams JSON lines with start/progress/done events as
    aria2 reports them. Stdout is reserved for JSON only; chatter from the
    shared lib (Write-Info etc.) is redirected to stderr.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet("parse","download")][string]$Action,
    [string]$ShareLink = "",
    [string]$FilePath = "",
    [long]$FileSize = 0,
    [string]$RelativePath = "",
    [string]$Domain = "",
    [string]$OutputDir = "",
    [int]$Connections = 0
)

$ErrorActionPreference = "Stop"
$script:BaseDir = Split-Path -Parent $MyInvocation.MyCommand.Definition | Split-Path -Parent
$script:ConfigPath = Join-Path $script:BaseDir "config.json"
$script:LogDir     = Join-Path $script:BaseDir "logs"
$script:TempDir    = Join-Path $script:BaseDir "temp"
$script:Aria2Path  = $null
$script:ActiveDownloads = @()

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

. (Join-Path $script:BaseDir "lib\log.ps1")
. (Join-Path $script:BaseDir "lib\i18n.ps1")
. (Join-Path $script:BaseDir "lib\core.ps1")

# Redirect human-readable chatter to stderr so stdout stays pure JSON.
function Write-Info    { param([string]$msg) [Console]::Error.WriteLine("[INFO] $msg");    if ($script:Logger) { $script:Logger.Info($msg) } }
function Write-Success { param([string]$msg) [Console]::Error.WriteLine("[OK]   $msg");    if ($script:Logger) { $script:Logger.Success($msg) } }
function Write-Warn    { param([string]$msg) [Console]::Error.WriteLine("[WARN] $msg");    if ($script:Logger) { $script:Logger.Warn($msg) } }
function Write-Err     { param([string]$msg) [Console]::Error.WriteLine("[ERR]  $msg");    if ($script:Logger) { $script:Logger.Error($msg) } }
function Show-Progress { } # bridge has its own progress callback

function Emit-Json {
    param($obj)
    $json = $obj | ConvertTo-Json -Compress -Depth 6
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

Load-Config

if (-not (Test-Aria2Installed)) {
    if (-not (Install-Aria2)) {
        Emit-Json @{ ok = $false; error = "aria2_install_failed" }
        exit 1
    }
}

if ($Action -eq "parse") {
    if (-not $ShareLink) { Emit-Json @{ ok=$false; error="no_link" }; exit 1 }
    $parsed = Parse-ShareLink -link $ShareLink
    if (-not $parsed) { Emit-Json @{ ok=$false; error="invalid_link" }; exit 1 }
    $info = Get-ShareInfo -shareId $parsed.ShareId -domain $parsed.Domain
    $files = Expand-FileList -shareId $parsed.ShareId -domain $parsed.Domain
    if (-not $files -or $files.Count -eq 0) { Emit-Json @{ ok=$false; error="no_files_found" }; exit 1 }
    $entries = @()
    foreach ($f in $files) {
        $entries += @{
            name = [string]$f.name
            size = [long]$f.size
            path = [string]$f.path
            relativePath = [string]$f._relativePath
        }
    }
    $shareInfoOut = $null
    if ($info) {
        $shareInfoOut = @{
            name      = [string]$info.name
            owner     = if ($info.owner) { [string]$info.owner.nickname } else { "" }
            views     = if ($info.visited) { [int]$info.visited } else { 0 }
            downloads = if ($info.downloaded) { [int]$info.downloaded } else { 0 }
        }
    }
    Emit-Json @{
        ok      = $true
        shareId = $parsed.ShareId
        domain  = $parsed.Domain
        info    = $shareInfoOut
        files   = $entries
        defaultOutputDir = [string]$script:Config.defaultOutputDir
        defaultConnections = [int]$script:Config.defaultConnections
    }
    exit 0
}

if ($Action -eq "download") {
    if (-not $FilePath) { Emit-Json @{ ok=$false; error="no_file_path" }; exit 1 }
    if (-not $Domain)   { $Domain = "https://pan.nekogal.top" }
    if (-not $OutputDir) { $OutputDir = $script:Config.defaultOutputDir }
    if ($Connections -le 0) { $Connections = $script:Config.defaultConnections }
    if (-not (Test-Path $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null }

    $url = Get-DownloadUrl -fileUri $FilePath -domain $Domain
    if (-not $url) { Emit-Json @{ ok=$false; error="cannot_get_url" }; exit 1 }

    $rawName = $FilePath
    if ($rawName -match '/([^/]+)$') { $rawName = $matches[1] }
    $rawName = [System.Uri]::UnescapeDataString($rawName)
    $safe = Sanitize-FileName -name $rawName

    $targetDir = $OutputDir
    if ($RelativePath) {
        $subDirs = $RelativePath -split "/" | ForEach-Object { Sanitize-FileName -name $_ }
        $targetDir = Join-Path $OutputDir ($subDirs -join "\")
        if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
    }
    $outPath = Join-Path $targetDir $safe

    Emit-Json @{ event = "start"; file = $safe; size = $FileSize; outPath = $outPath }

    $cb = {
        param($p)
        Emit-Json @{
            event   = "progress"
            current = [long]$p.Current
            total   = [long]$p.Total
            speed   = [long]$p.Speed
            file    = [string]$p.FileName
        }
    }

    $code = Start-FileDownload -url $url -outPath $outPath -fileSize $FileSize -conn $Connections -domain $Domain -OnProgress $cb
    Emit-Json @{ event = "done"; code = $code; file = $safe }
    exit $code
}
