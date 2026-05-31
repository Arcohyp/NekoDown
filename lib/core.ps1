#Requires -Version 5.1

# Core download logic shared by the CLI (neko-down.ps1) and GUI (neko-down-gui.ps1).
# Both entries dot-source this file along with lib/log.ps1 and lib/i18n.ps1.
# All functions assume $script:BaseDir, $script:ConfigPath, $script:LogDir,
# $script:TempDir are set by the caller before invocation.

# ==================== Config ====================
function Get-DefaultConfig {
    return [ordered]@{
        defaultOutputDir   = Join-Path $script:BaseDir "downloads"
        defaultConnections = 16
        autoRetry          = $true
        maxRetries         = 3
        logEnabled         = $true
        checkDiskSpace     = $true
        minFreeSpaceGB     = 2
        proxy              = ""
        language           = "auto"
    }
}

function Save-Config {
    $script:Config | ConvertTo-Json -Depth 3 | Set-Content $script:ConfigPath -Encoding UTF8
}

function Load-Config {
    Initialize-I18n -baseDir $script:BaseDir

    if (Test-Path $script:ConfigPath) {
        try {
            $jsonObj = Get-Content $script:ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
            # Convert PSCustomObject -> ordered hashtable so property assignment in
            # closures (GUI Apply button) is reliable. PSCustomObject in PS5.1 can
            # reject property writes inside certain handler scopes with
            # "property cannot be found on this object".
            $script:Config = [ordered]@{}
            foreach ($p in $jsonObj.PSObject.Properties) {
                $script:Config[$p.Name] = $p.Value
            }
            $needsSave = $false
            # Only reset the output dir if the previously configured path no longer exists.
            # This preserves user-chosen external directories (e.g. D:\Downloads).
            if ($script:Config.defaultOutputDir -and -not (Test-Path $script:Config.defaultOutputDir)) {
                Write-Info (L "detected_folder_move")
                $script:Config.defaultOutputDir = Join-Path $script:BaseDir "downloads"
                $needsSave = $true
            }
            if (-not $script:Config.language) {
                $script:Config.language = "auto"
                $needsSave = $true
            }
            if ($needsSave) { Save-Config }
        } catch {
            Write-Warn (L "config_corrupted")
            $script:Config = Get-DefaultConfig
        }
    } else {
        $script:Config = Get-DefaultConfig
        Save-Config
    }

    $script:Logger = [DownloaderLogger]::new($script:LogDir, [bool]$script:Config.logEnabled)

    if (-not (Test-Path $script:TempDir)) {
        try {
            New-Item -ItemType Directory -Path $script:TempDir -Force | Out-Null
            Write-Info "$(L "created_temp_dir"): $($script:TempDir)"
        } catch {
            Write-Err "$(L "temp_dir_failed"): $($script:TempDir)"
            throw
        }
    }
}

# ==================== aria2 detection / install ====================
function Test-Aria2Installed {
    try {
        $cmd = Get-Command aria2c -ErrorAction Stop
        $script:Aria2Path = $cmd.Source
    } catch {
        $paths = @(
            "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\aria2.aria2_Microsoft.Winget.Source_8wekyb3d8bbwe"
            "$env:LOCALAPPDATA\Microsoft\WinGet\Links"
            "$env:PROGRAMFILES\aria2"
            "$env:PROGRAMFILES(X86)\aria2"
        )
        foreach ($p in $paths) {
            if (Test-Path $p) {
                $exe = Get-ChildItem -Path $p -Filter "aria2c.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($exe) {
                    $script:Aria2Path = $exe.FullName
                    break
                }
            }
        }
    }

    if (-not $script:Aria2Path -or -not (Test-Path $script:Aria2Path)) {
        $toolsAria2 = Join-Path $script:BaseDir "tools\aria2\aria2c.exe"
        if (Test-Path $toolsAria2) {
            $script:Aria2Path = $toolsAria2
        }
    }

    if (-not $script:Aria2Path -or -not (Test-Path $script:Aria2Path)) {
        return $false
    }

    try {
        $versionOutput = & $script:Aria2Path --version 2>&1 | Select-Object -First 1
        Write-Info "aria2 version: $versionOutput"
        return $true
    } catch {
        Write-Warn (L "aria2_install_failed")
        return $false
    }
}

function Install-Aria2 {
    Write-Warn (L "aria2_not_found")

    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Info "winget found, trying to install aria2 via winget..."
        try {
            $proc = Start-Process -FilePath "winget" -ArgumentList "install","aria2.aria2","--silent","--accept-source-agreements","--accept-package-agreements" -Wait -PassThru -WindowStyle Hidden
            if ($proc.ExitCode -eq 0) {
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
                Start-Sleep -Seconds 2
                if (Test-Aria2Installed) { return $true }
                $wingetPaths = @(
                    "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\aria2.aria2_Microsoft.Winget.Source_8wekyb3d8bbwe"
                    "$env:LOCALAPPDATA\Microsoft\WinGet\Links"
                )
                foreach ($p in $wingetPaths) {
                    if (Test-Path $p) {
                        $exe = Get-ChildItem -Path $p -Filter "aria2c.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
                        if ($exe) {
                            $script:Aria2Path = $exe.FullName
                            Write-Success (L "aria2_ready")
                            return $true
                        }
                    }
                }
            }
        } catch {
            Write-Warn "winget install failed: $_"
        }
    }

    Write-Info "winget not available or failed, downloading portable aria2 from GitHub..."
    $toolsDir = Join-Path $script:BaseDir "tools"
    $aria2Dir = Join-Path $toolsDir "aria2"
    if (-not (Test-Path $toolsDir)) { New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null }

    Write-Info (L "aria2_downloading")
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/aria2/aria2/releases/latest" -TimeoutSec 30
        $asset = $release.assets | Where-Object { $_.name -like "*win-64bit*.zip" } | Select-Object -First 1
        if (-not $asset) {
            Write-Warn "Could not find aria2 Windows release"
            return $false
        }
        $zipPath = Join-Path $toolsDir "aria2.zip"
        $wc = New-Object System.Net.WebClient
        $wc.DownloadFile($asset.browser_download_url, $zipPath)

        Write-Info (L "aria2_extracting")
        Expand-Archive -Path $zipPath -DestinationPath $toolsDir -Force
        $extracted = Get-ChildItem -Path $toolsDir -Directory | Where-Object { $_.Name -like "aria2-*-win-64bit*" } | Select-Object -First 1
        if ($extracted) {
            if (Test-Path $aria2Dir) { Remove-Item $aria2Dir -Recurse -Force }
            New-Item -ItemType Directory -Path $aria2Dir -Force | Out-Null
            Get-ChildItem -Path $extracted.FullName | Move-Item -Destination $aria2Dir -Force
            Remove-Item $extracted.FullName -Recurse -Force
        }
        Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
        $script:Aria2Path = Join-Path $aria2Dir "aria2c.exe"
        if (Test-Path $script:Aria2Path) {
            Write-Success (L "aria2_ready")
            return $true
        }
    } catch {
        Write-Warn "Failed to auto-install aria2: $_"
    }
    return $false
}

# ==================== Cleanup ====================
function Cleanup-TempFiles {
    Write-Info (L "cleanup")
    $temps = Get-ChildItem -Path $script:TempDir -Filter "*.tmp" -ErrorAction SilentlyContinue
    foreach ($t in $temps) {
        try {
            Remove-Item $t.FullName -Force -ErrorAction SilentlyContinue
            Write-Info "Removed: $($t.Name)"
        } catch {}
    }
}

# ==================== Disk space ====================
function Test-DiskSpace {
    param([long]$requiredBytes, [string]$path)
    if (-not $script:Config.checkDiskSpace) { return $true }
    $drive = (Get-Item $path).PSDrive.Name
    $disk = Get-PSDrive $drive
    $freeGB = [math]::Round($disk.Free / 1GB, 2)
    $requiredGB = [math]::Round($requiredBytes / 1GB, 2)
    $minGB = $script:Config.minFreeSpaceGB
    Write-Info "$(L "disk_space_check"): $freeGB GB free, $requiredGB GB required, $minGB GB minimum"
    if ($freeGB -lt ($requiredGB + $minGB)) {
        Write-Err (L "insufficient_space")
        Write-Err "Free: $freeGB GB | Required: $requiredGB GB | Min reserve: $minGB GB"
        return $false
    }
    return $true
}

# ==================== Share link parser ====================
function Parse-ShareLink {
    param([string]$link)
    $link = $link.Trim()
    if ($link -match 'https?://[^/]+/s/([a-zA-Z0-9]+)') {
        return @{ ShareId = $matches[1]; Domain = ($link -split '/s/')[0] }
    }
    if ($link -match 'cloudreve%3A%2F%2F([a-zA-Z0-9%:]+)%40share') {
        $shareId = [System.Uri]::UnescapeDataString($matches[1])
        $domain = "https://pan.nekogal.top"
        if ($link -match 'https?://[^/]+') { $domain = $matches[0] }
        return @{ ShareId = $shareId; Domain = $domain }
    }
    if ($link -match '^([a-zA-Z0-9]{6,})$') {
        return @{ ShareId = $matches[1]; Domain = "https://pan.nekogal.top" }
    }
    return $null
}

# ==================== Cloudreve API ====================
function Get-ShareInfo {
    param([string]$shareId, [string]$domain)
    $endpoints = @(
        "$domain/share/info/$shareId"
        "$domain/api/v4/share/info/$shareId"
        "$domain/api/v3/share/info/$shareId"
    )
    foreach ($uri in $endpoints) {
        try {
            $r = Invoke-RestMethod -Uri $uri -TimeoutSec 30
            if ($r.code -eq 0 -and $r.data) {
                $json = $r.data | ConvertTo-Json -Compress -Depth 3
                Write-Info "Share info from $uri -> $json"
                return $r.data
            }
        } catch {
            Write-Warn "Failed to get share info from $uri : $_"
        }
    }
    return $null
}

function Get-FileList {
    param([string]$shareId, [string]$domain)
    $uri = [System.Uri]::EscapeDataString("cloudreve://$shareId@share/")
    try {
        $r = Invoke-RestMethod -Uri "$domain/api/v4/file?uri=$uri" -TimeoutSec 30
        if ($r.code -eq 0) { return $r.data }
    } catch { Write-Warn "Failed to get file list: $_" }
    return $null
}

function Get-DownloadUrl {
    param([string]$fileUri, [string]$domain)
    $body = @{ uris = @($fileUri); download = $true } | ConvertTo-Json -Compress
    try {
        $r = Invoke-RestMethod -Uri "$domain/api/v4/file/url" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 30
        if ($r.code -eq 0 -and $r.data -and $r.data.urls) { return $r.data.urls[0].url }
        else { Write-Warn "API error: $($r.msg)" }
    } catch { Write-Warn "Failed to get download URL: $_" }
    return $null
}

function Expand-FileList {
    param([string]$shareId, [string]$domain, [string]$basePath = "")
    $results = @()
    $uriSuffix = if ($basePath) { "/$basePath/" } else { "/" }
    $uri = [System.Uri]::EscapeDataString("cloudreve://$shareId@share$uriSuffix")
    try {
        $r = Invoke-RestMethod -Uri "$domain/api/v4/file?uri=$uri" -TimeoutSec 30
        if ($r.code -eq 0 -and $r.data -and $r.data.files) {
            foreach ($f in $r.data.files) {
                if ($f.type -eq 1) {
                    $subPath = if ($basePath) { "$basePath/$($f.name)" } else { $f.name }
                    $subFiles = Expand-FileList -shareId $shareId -domain $domain -basePath $subPath
                    $results += $subFiles
                } else {
                    if ($basePath) {
                        $f | Add-Member -NotePropertyName '_relativePath' -NotePropertyValue $basePath -Force
                    }
                    $results += $f
                }
            }
        }
    } catch { Write-Warn "Failed to expand directory '$basePath': $_" }
    return ,$results
}

# ==================== Network diagnostics ====================
function Test-UrlAccessibility {
    param([string]$url, [string]$referer)
    Write-Info (L "testing_url")
    try {
        $req = [System.Net.WebRequest]::Create($url)
        $req.Method = "GET"
        $req.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
        $req.Referer = $referer
        $req.Timeout = 15000
        $req.AllowAutoRedirect = $true
        $req.AddRange(0, 0)
        $response = $req.GetResponse()
        $status = [int]$response.StatusCode
        $response.Close()
        if ($status -eq 200 -or $status -eq 206 -or $status -eq 302 -or $status -eq 307) {
            Write-Success (L "url_accessible" -f $status)
            return $true
        } else {
            Write-Warn (L "url_returned_http" -f $status)
            return $false
        }
    } catch [System.Net.WebException] {
        $statusCode = $null
        if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
        $errorMsg = $_.Exception.Message
        if ($statusCode -eq 403) {
            Write-Info (L "url_precheck_403")
        } elseif ($statusCode -eq 401) {
            Write-Warn (L "url_blocked_401")
        } elseif ($errorMsg -match "SSL" -or $errorMsg -match "TLS") {
            Write-Warn (L "tls_ssl_error" -f $errorMsg)
        } else {
            Write-Warn (L "url_test_failed" -f $errorMsg)
        }
        return $false
    } catch {
        Write-Warn (L "url_test_failed" -f $_)
        return $false
    }
}

# ==================== Format helpers ====================
function Format-Size {
    param([long]$size)
    if ($size -gt 1GB) { return "{0:N2} GB" -f ($size / 1GB) }
    if ($size -gt 1MB) { return "{0:N2} MB" -f ($size / 1MB) }
    if ($size -gt 1KB) { return "{0:N2} KB" -f ($size / 1KB) }
    return "$size B"
}

function Format-Speed {
    param([long]$bytesPerSec)
    if ($bytesPerSec -gt 1GB) { return "{0:N2} GB/s" -f ($bytesPerSec / 1GB) }
    if ($bytesPerSec -gt 1MB) { return "{0:N2} MB/s" -f ($bytesPerSec / 1MB) }
    if ($bytesPerSec -gt 1KB) { return "{0:N2} KB/s" -f ($bytesPerSec / 1KB) }
    return "$bytesPerSec B/s"
}

function Get-Aria2ErrorDescription {
    param([int]$exitCode)
    $known = @{
        3 = "aria2_exit_3"; 7 = "aria2_exit_7"; 15 = "aria2_exit_15"; 16 = "aria2_exit_16"
        18 = "aria2_exit_18"; 21 = "aria2_exit_21"; 22 = "aria2_exit_22"; 24 = "aria2_exit_24"
    }
    if ($known.ContainsKey($exitCode)) { return (L $known[$exitCode]) }
    return (L "aria2_exit_unknown" -f $exitCode)
}

function Sanitize-FileName {
    param([string]$name)
    $invalid = [System.IO.Path]::GetInvalidFileNameChars()
    foreach ($c in $invalid) { $name = $name.Replace([string]$c, "_") }
    # Prevent path traversal via relative path separators or dot sequences
    $name = $name -replace '[\\/]', '_'
    $name = $name -replace '\.{2,}', '_'
    $name = $name.TrimEnd(" .")
    $reserved = @("CON","PRN","AUX","NUL") + (1..9 | ForEach-Object { "COM$_"; "LPT$_" })
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($name)
    if ($reserved -contains $baseName.ToUpper()) {
        $ext = [System.IO.Path]::GetExtension($name)
        $name = "_" + $baseName + $ext
    }
    if ([string]::IsNullOrWhiteSpace($name)) { $name = "unnamed" }
    return $name
}

# ==================== Download (with optional progress callback) ====================
# OnProgress callback receives @{ Current; Total; Speed; FileName }.
# CancelToken is a synchronized hashtable; if .Cancel = $true the aria2 process is killed.
# When OnProgress is omitted, falls back to console Show-Progress (CLI behavior).
function Start-FileDownload {
    param(
        [string]$url,
        [string]$outPath,
        [long]$fileSize,
        [int]$conn = 16,
        [string]$domain = "",
        [scriptblock]$OnProgress = $null,
        [hashtable]$CancelToken = $null
    )

    $outDir = Split-Path $outPath -Parent
    $fileName = Split-Path $outPath -Leaf
    $tempFileName = $fileName + ".tmp"
    $tempPath = Join-Path $outDir $tempFileName
    $aria2CtrlFile = Join-Path $outDir ($tempFileName + ".aria2")

    $logName = [Guid]::NewGuid().ToString("N") + ".aria2.log"
    $relativeLog = "temp\$logName"
    $ariaLog = Join-Path $script:BaseDir $relativeLog

    $resume = $false
    if (Test-Path $aria2CtrlFile) {
        $ctrlSize = if (Test-Path $tempPath) { (Get-Item $tempPath).Length } else { 0 }
        Write-Info (L "resuming_download" -f ($ctrlSize/1MB))
        $resume = $true
    }

    Test-UrlAccessibility -url $url -referer $domain | Out-Null

    $ariaArgs = @(
        "-x", "$conn",
        "-s", "$conn",
        "-k", "1M",
        "--file-allocation=none",
        "--disk-cache=64M",
        "--max-connection-per-server=$conn",
        "--min-split-size=1M",
        "--log-level=notice",
        "--log=$relativeLog",
        "--dir=$outDir",
        "--out=$tempFileName",
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        "--header=Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "--header=Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
        "--header=Accept-Encoding: gzip, deflate, br",
        "--header=DNT: 1",
        "--check-certificate=true",
        "--async-dns=false"
    )
    if ($resume) { $ariaArgs += "--continue=true" }
    $ariaArgs += "$url"
    if ($domain) { $ariaArgs += "--referer=$domain" }
    if ($script:Config.proxy -and $script:Config.proxy -ne "") {
        $ariaArgs += "--all-proxy=$($script:Config.proxy)"
    }

    Write-Info (L "starting_download")
    if ($script:Logger) { $script:Logger.Info("Download started: $url -> $outPath") }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:Aria2Path
    # Safe argument join: quote arguments that contain spaces or quotes to
    # prevent injection into aria2c's command-line parser.
    $safeArgs = $ariaArgs | ForEach-Object {
        $arg = $_
        if ($arg -match '[\s"]') {
            '"' + ($arg -replace '"', '\"') + '"'
        } else {
            $arg
        }
    }
    $psi.Arguments = $safeArgs -join " "
    $psi.WorkingDirectory = $script:BaseDir
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi

    $stdOut = [System.Text.StringBuilder]::new()
    $stdErr = [System.Text.StringBuilder]::new()
    $outHandler = { $stdOut.AppendLine($EventArgs.Data) | Out-Null }
    $errHandler = { $stdErr.AppendLine($EventArgs.Data) | Out-Null }
    Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -Action $outHandler | Out-Null
    Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -Action $errHandler | Out-Null

    $startTime = Get-Date
    $startSize = if (Test-Path $tempPath) { (Get-Item $tempPath -ErrorAction SilentlyContinue).Length } else { 0 }

    [void]$process.Start()
    $process.BeginOutputReadLine()
    $process.BeginErrorReadLine()
    if ($null -eq $script:ActiveDownloads) { $script:ActiveDownloads = @() }
    $script:ActiveDownloads += $process

    while (-not $process.HasExited) {
        if ($CancelToken -and $CancelToken.Cancel) {
            try { $process.Kill() } catch {}
            break
        }
        if (Get-Command Check-Interrupt -ErrorAction SilentlyContinue) {
            Check-Interrupt
        }
        if (Test-Path $tempPath) {
            try {
                $currentSize = (Get-Item $tempPath -ErrorAction SilentlyContinue).Length
                if ($currentSize -gt 0) {
                    $elapsed = ((Get-Date) - $startTime).TotalSeconds
                    if ($elapsed -gt 0) {
                        $sessionBytes = [math]::Max(0, $currentSize - $startSize)
                        $speed = [long]($sessionBytes / $elapsed)
                        if ($OnProgress) {
                            & $OnProgress @{ Current = $currentSize; Total = $fileSize; Speed = $speed; FileName = $fileName }
                        } else {
                            Show-Progress -Current $currentSize -Total $fileSize -Speed $speed -FileName $fileName
                        }
                    }
                }
            } catch {
                Write-Err "Progress monitoring error: $_"
            }
        }
        Start-Sleep -Milliseconds 500
    }

    Start-Sleep -Milliseconds 300
    $script:ActiveDownloads = $script:ActiveDownloads | Where-Object { $_ -ne $process }
    if (-not $OnProgress) { Write-Host "" }

    $errorDetails = ""
    if (Test-Path $ariaLog) {
        try {
            $logContent = Get-Content $ariaLog -Tail 30 -ErrorAction SilentlyContinue
            $errorLines = $logContent | Where-Object { $_ -match "ERROR|WARN|error|failed|exception" } | Select-Object -Last 10
            if ($errorLines) { $errorDetails = $errorLines -join "`n" }
        } catch {}
    }
    $stderrText = $stdErr.ToString().Trim()
    if ($stderrText) { $errorDetails += "`n[Direct stderr]:`n$stderrText" }

    if ($process.ExitCode -eq 0 -and (Test-Path $tempPath)) {
        $actualSize = (Get-Item $tempPath).Length
        if ($actualSize -eq $fileSize) {
            if (Test-Path $outPath) { Remove-Item $outPath -Force }
            Move-Item -Path $tempPath -Destination $outPath -Force
            if ($script:Logger) { $script:Logger.Success("Download completed: $outPath") }
            if (Test-Path $aria2CtrlFile) { Remove-Item $aria2CtrlFile -Force -ErrorAction SilentlyContinue }
            if (Test-Path $ariaLog) { Remove-Item $ariaLog -Force -ErrorAction SilentlyContinue }
            return 0
        } else {
            Write-Warn "$(L "size_mismatch"): expected $fileSize, got $actualSize"
            if ($actualSize -lt 1MB) {
                if (Test-Path $tempPath) { Remove-Item $tempPath -Force -ErrorAction SilentlyContinue }
                if (Test-Path $aria2CtrlFile) { Remove-Item $aria2CtrlFile -Force -ErrorAction SilentlyContinue }
            }
            if (Test-Path $ariaLog) { Remove-Item $ariaLog -Force -ErrorAction SilentlyContinue }
            return 1
        }
    } else {
        $aria2Desc = Get-Aria2ErrorDescription -exitCode $process.ExitCode
        Write-Err "$aria2Desc"
        if ($errorDetails) {
            Write-Err "Details:"
            Write-Host $errorDetails -ForegroundColor DarkGray
            if ($script:Logger) { $script:Logger.Error("aria2 error: $errorDetails") }
        }
        $diagnosticLog = Join-Path $script:LogDir "aria2-failed-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
        if (Test-Path $ariaLog) {
            try {
                Copy-Item $ariaLog $diagnosticLog -Force -ErrorAction SilentlyContinue
                Write-Info "Diagnostic log saved: $diagnosticLog"
            } catch {}
            Remove-Item $ariaLog -Force -ErrorAction SilentlyContinue
        }
        return $process.ExitCode
    }
}
