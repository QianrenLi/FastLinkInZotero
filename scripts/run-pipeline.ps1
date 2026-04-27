$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")
Set-Location $RepoRoot

function Normalize-NodeVersion {
    param([string]$Version)
    $v = $Version.Trim() -replace "`r", ""
    $v = ($v -split "\s+")[0]
    if ($v -match "^v\d") { return $v }
    if ($v -match "^\d") { return "v$v" }
    return ""
}

# Determine target Node version
if ($env:FASTLINK_NODE_VERSION) {
    $TargetRaw = $env:FASTLINK_NODE_VERSION
} elseif (Test-Path "$RepoRoot\.nvmrc") {
    $TargetRaw = (Get-Content "$RepoRoot\.nvmrc" -Raw).Trim()
} else {
    Write-Error "FastLink pipeline error: set FASTLINK_NODE_VERSION or add .nvmrc."
    exit 1
}

$TargetVersion = Normalize-NodeVersion $TargetRaw
if (-not $TargetVersion) {
    Write-Error "FastLink pipeline error: invalid Node version '$TargetRaw'."
    exit 1
}

# Capture current Node version
$OriginalVersion = ""
try {
    $OriginalVersion = Normalize-NodeVersion (nvm current 2>$null)
} catch {}
if (-not $OriginalVersion) {
    try { $OriginalVersion = Normalize-NodeVersion (node -v 2>$null) } catch {}
}

function Restore-Node {
    if ($OriginalVersion -and $OriginalVersion -ne $TargetVersion) {
        Write-Host "==> Restoring Node $OriginalVersion"
        nvm use $OriginalVersion *>&1 | Out-Null
    }
}

function Run-Step {
    param([scriptblock]$Cmd)
    Write-Host ""
    Write-Host "==> $Cmd"
    & $Cmd
}

function Run-NamedStep {
    param([string]$Name)
    switch ($Name) {
        "lint"      { Run-Step { npm run lint:check } }
        "build"     { Run-Step { npm run build } }
        "test"      { Run-Step { npm test } }
        "typecheck" { Run-Step { npx tsc --noEmit } }
        default {
            Write-Error "FastLink pipeline error: unknown step '$Name'."
            Write-Host "Supported steps: lint build test typecheck"
            exit 1
        }
    }
}

try {
    $FromVersion = if ($OriginalVersion) { $OriginalVersion } else { "unknown" }
    Write-Host "==> Switching Node from $FromVersion to $TargetVersion"
    nvm use $TargetRaw *>&1 | Out-Null

    Run-Step { node -v }
    Run-Step { npm -v }

    if ($args.Count -eq 0) {
        $steps = @("lint", "build", "test")
    } else {
        $steps = $args
    }

    foreach ($step in $steps) {
        Run-NamedStep $step
    }
} finally {
    Restore-Node
}
