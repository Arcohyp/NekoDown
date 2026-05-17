<#
.SYNOPSIS
    Bump NekoDown version across all source files.
.DESCRIPTION
    Updates version in Cargo.toml, tauri.conf.json, neko-down.ps1,
    and inserts a new changelog entry in README.md.
    Then stages, commits, tags, and pushes.
.PARAMETER NewVersion
    Semantic version string, e.g. "3.4.0" or "3.3.5".
.PARAMETER DryRun
    Show what would change without modifying files.
.PARAMETER NoPush
    Stage, commit, tag, but do NOT push to remote.
.EXAMPLE
    .\scripts\bump-version.ps1 3.4.0
.EXAMPLE
    .\scripts\bump-version.ps1 3.4.0 -DryRun
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$NewVersion,

    [switch]$DryRun,
    [switch]$NoPush
)

if ($NewVersion -notmatch '^\d+\.\d+\.\d+$') {
    Write-Error "Invalid version '${NewVersion}'. Expected format: x.y.z (e.g. 3.4.0)"
    exit 1
}

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$Today = Get-Date -Format "yyyy-MM-dd"

# ── File manifests ──────────────────────────────────────────────────

$files = @(
    @{
        Path    = Join-Path $Root "gui-tauri\src-tauri\Cargo.toml"
        Pattern = 'version = "\d+\.\d+\.\d+"'
        Replace = 'version = "' + $NewVersion + '"'
        Label   = 'Cargo.toml'
    }
    @{
        Path    = Join-Path $Root "gui-tauri\src-tauri\tauri.conf.json"
        Pattern = '"version": "\d+\.\d+\.\d+"'
        Replace = '"version": "' + $NewVersion + '",'
        Label   = 'tauri.conf.json'
    }
    @{
        Path    = Join-Path $Root "neko-down.ps1"
        Pattern = '\$script:Version = "\d+\.\d+\.\d+"'
        Replace = '$script:Version = "' + $NewVersion + '"'
        Label   = 'neko-down.ps1'
    }
)

# ── Phase 1: Update mechanical version files ────────────────────────

Write-Host "`n==> Bumping version to $NewVersion" -ForegroundColor Cyan

foreach ($f in $files) {
    $content = Get-Content -LiteralPath $f.Path -Raw
    if ($content -match $f.Pattern) {
        $newContent = $content -replace $f.Pattern, $f.Replace
        if (-not $DryRun) {
            Set-Content -LiteralPath $f.Path -Value $newContent -NoNewline
        }
        Write-Host "  ✓ $($f.Label)" -ForegroundColor Green
    } else {
        Write-Warning "  ⚠ Pattern not matched in $($f.Label)"
    }
}

# ── Phase 2: Update README.md changelog ──────────────────────────────

$readmePath = Join-Path $Root "README.md"
$readme = Get-Content -LiteralPath $readmePath -Raw

$insertMarker = "详见 [GitHub Releases]"
$idx = $readme.IndexOf($insertMarker)
if ($idx -ge 0) {
    # Find the blank line after the "详见 GitHub Releases" paragraph
    $afterLink = $readme.IndexOf("`n`n", $idx)
    if ($afterLink -lt 0) { $afterLink = $idx }

    # Build the new changelog entry
    $newEntry = @"

### v$NewVersion ($Today)

- (TODO: fill release notes)

"@

    $newReadme = $readme.Substring(0, $afterLink + 2) + $newEntry + $readme.Substring($afterLink + 2).TrimStart()

    if (-not $DryRun) {
        Set-Content -LiteralPath $readmePath -Value $newReadme -NoNewline
    }
    Write-Host "  ✓ README.md changelog" -ForegroundColor Green
} else {
    Write-Warning "  ⚠ Could not find changelog section in README.md"
}

# ── Phase 3: git operations ─────────────────────────────────────────

if (-not $DryRun) {
    Write-Host "`n==> Staging changes..." -ForegroundColor Cyan
    git add -A
    git commit -m "chore: bump version to ${NewVersion}"

    Write-Host "`n==> Tagging v${NewVersion}..." -ForegroundColor Cyan
    git tag -a "v${NewVersion}" -m "v${NewVersion}"

    if (-not $NoPush) {
        Write-Host "`n==> Pushing commit + tag..." -ForegroundColor Cyan
        git push
        git push origin "v${NewVersion}"
        Write-Host "  ✓ Pushed to remote" -ForegroundColor Green
    } else {
        Write-Host "`n  (--NoPush: skipping push)" -ForegroundColor Yellow
    }

    Write-Host "`n✅ Version ${NewVersion} released!" -ForegroundColor Green
    Write-Host "   Check the workflow at: https://github.com/Arcohyp/NekoDown/actions" -ForegroundColor Cyan
} else {
    Write-Host "`n(Dry-run mode — no files changed)" -ForegroundColor Yellow
}
