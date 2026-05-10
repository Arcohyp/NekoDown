#Requires -Version 5.1

# Loads lang.json into $script:LangDict (hashtable of hashtables).
# CLI / GUI both call this once after the script base directory is known.
function Initialize-I18n {
    param([string]$baseDir)

    $script:LangDict = @{ "en-US" = @{}; "zh-CN" = @{} }
    $langPath = Join-Path $baseDir "lang.json"
    if (-not (Test-Path $langPath)) {
        Write-Warning "lang.json not found at $langPath. Falling back to keys."
        return
    }
    try {
        $raw = Get-Content $langPath -Raw -Encoding UTF8
        $obj = $raw | ConvertFrom-Json
        $hash = @{}
        foreach ($prop in $obj.PSObject.Properties) {
            $sub = @{}
            foreach ($p in $prop.Value.PSObject.Properties) {
                $sub[$p.Name] = $p.Value
            }
            $hash[$prop.Name] = $sub
        }
        $script:LangDict = $hash
    } catch {
        Write-Warning ("Failed to load lang.json: {0}" -f $_)
    }
}

# Resolve "auto" against the current UI culture; pin to en-US if unrecognized.
function Resolve-Language {
    param([string]$lang)
    if ($lang -eq "auto" -or [string]::IsNullOrWhiteSpace($lang)) {
        try {
            $ui = (Get-UICulture).Name
            if ($ui -like "zh*") { return "zh-CN" } else { return "en-US" }
        } catch {
            return "en-US"
        }
    }
    if ($script:LangDict -and $script:LangDict.ContainsKey($lang)) { return $lang }
    return "en-US"
}

# Look up a translation key. Falls back to en-US, then to the raw key.
# Usage: L "key"   |   L "key" -f $arg1, $arg2
function L {
    param(
        [string]$key,
        [array]$formatArgs
    )
    $lang = "en-US"
    if ($script:Config -and $script:Config.language) {
        $lang = Resolve-Language -lang $script:Config.language
    }
    $dict = $null
    if ($script:LangDict -and $script:LangDict.ContainsKey($lang)) {
        $dict = $script:LangDict[$lang]
    }
    $text = $null
    if ($dict -and $dict.ContainsKey($key)) {
        $text = $dict[$key]
    } elseif ($script:LangDict -and $script:LangDict.ContainsKey("en-US") -and $script:LangDict["en-US"].ContainsKey($key)) {
        $text = $script:LangDict["en-US"][$key]
    } else {
        $text = $key
    }
    if ($formatArgs -and $formatArgs.Count -gt 0) {
        return ($text -f $formatArgs)
    }
    return $text
}
