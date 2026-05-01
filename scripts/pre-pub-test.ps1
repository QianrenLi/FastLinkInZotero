# pre-pub-test.ps1 — Pre-publish validation for FastLinkInZotero
# Runs: lint, typecheck, build, test, and verifies the XPI is produced.
# Usage:
#   ./scripts/pre-pub-test.ps1              # run all steps
#   ./scripts/pre-pub-test.ps1 lint build   # run specific steps

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")
Set-Location $RepoRoot

# ── Colors ────────────────────────────────────────────────────────────────────
function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}
function Write-Ok {
    param([string]$Message)
    Write-Host "  OK  $Message" -ForegroundColor Green
}
function Write-Fail {
    param([string]$Message)
    Write-Host "  FAIL  $Message" -ForegroundColor Red
}
function Write-Info {
    param([string]$Message)
    Write-Host "  $Message" -ForegroundColor DarkGray
}

# ── Node version management (same as run-pipeline.ps1) ───────────────────────
function Normalize-NodeVersion {
    param([string]$Version)
    $v = $Version.Trim() -replace "`r", ""
    $v = ($v -split "\s+")[0]
    if ($v -match "^v\d") { return $v }
    if ($v -match "^\d") { return "v$v" }
    return ""
}

if ($env:FASTLINK_NODE_VERSION) {
    $TargetRaw = $env:FASTLINK_NODE_VERSION
} elseif (Test-Path "$RepoRoot\.nvmrc") {
    $TargetRaw = (Get-Content "$RepoRoot\.nvmrc" -Raw).Trim()
} else {
    Write-Fail "Set FASTLINK_NODE_VERSION or add .nvmrc."
    exit 1
}

$TargetVersion = Normalize-NodeVersion $TargetRaw
if (-not $TargetVersion) {
    Write-Fail "Invalid Node version '$TargetRaw'."
    exit 1
}

$OriginalVersion = ""
try {
    $OriginalVersion = Normalize-NodeVersion (nvm current 2>$null)
} catch {}
if (-not $OriginalVersion) {
    try { $OriginalVersion = Normalize-NodeVersion (node -v 2>$null) } catch {}
}

function Restore-Node {
    if ($OriginalVersion -and $OriginalVersion -ne $TargetVersion) {
        Write-Info "Restoring Node $OriginalVersion"
        nvm use $OriginalVersion *>&1 | Out-Null
    }
}

# ── Test result tracking ─────────────────────────────────────────────────────
$Results = @()
$Failed = $false

function Record-Result {
    param([string]$Step, [bool]$Success, [string]$Detail = "")
    $script:Results += [PSCustomObject]@{
        Step    = $Step
        Success = $Success
        Detail  = $Detail
    }
    if (-not $Success) { $script:Failed = $true }
}

# ── Individual test steps ────────────────────────────────────────────────────

function Step-Lint {
    Write-Step "Linting (prettier + eslint)"
    try {
        npm run lint:check 2>&1 | ForEach-Object { Write-Info $_ }
        if ($LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE" }
        Write-Ok "Lint passed"
        Record-Result "lint" $true
    } catch {
        Write-Fail "Lint failed"
        Record-Result "lint" $false $_
    }
}

function Step-TypeCheck {
    Write-Step "Type checking (tsc --noEmit)"
    try {
        npx tsc --noEmit 2>&1 | ForEach-Object { Write-Info $_ }
        if ($LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE" }
        Write-Ok "Type check passed"
        Record-Result "typecheck" $true
    } catch {
        Write-Fail "Type check failed"
        Record-Result "typecheck" $false $_
    }
}

function Step-Build {
    Write-Step "Building production XPI"
    try {
        npm run build 2>&1 | ForEach-Object { Write-Info $_ }
        if ($LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE" }

        # Verify XPI exists
        $XpiFiles = Get-ChildItem "$RepoRoot\.scaffold\build\*.xpi" -ErrorAction SilentlyContinue
        if (-not $XpiFiles) {
            throw "No .xpi file found in .scaffold/build/"
        }

        $Xpi = $XpiFiles[0]
        $SizeKB = [math]::Round($Xpi.Length / 1KB, 1)

        # Verify bundle doesn't contain debug-only code
        $Bundle = "$RepoRoot\.scaffold\build\addon\content\scripts\fastlink.js"
        if (Test-Path $Bundle) {
            $Forbidden = @("registerDebugMenu", "setupFileLogging", "file-logger")
            foreach ($pattern in $Forbidden) {
                if (Select-String -Path $Bundle -Pattern $pattern -Quiet) {
                    throw "Bundle contains debug code: $pattern"
                }
            }
        }

        Write-Ok "Build passed ($($Xpi.Name), ${SizeKB} KB)"
        Record-Result "build" $true "${SizeKB} KB"
    } catch {
        Write-Fail "Build failed"
        Record-Result "build" $false $_
    }
}

function Step-Test {
    Write-Step "Running tests (zotero-plugin test)"
    try {
        npm test 2>&1 | ForEach-Object { Write-Info $_ }
        if ($LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE" }
        Write-Ok "Tests passed"
        Record-Result "test" $true
    } catch {
        Write-Fail "Tests failed"
        Record-Result "test" $false $_
    }
}

function Step-DeadCode {
    Write-Step "Checking for dead imports / unreferenced modules"
    try {
        $SrcFiles = Get-ChildItem "$RepoRoot\src\**\*.ts" -Recurse -File
        $AllImports = @()

        # Collect all import targets
        foreach ($file in $SrcFiles) {
            $matches = [regex]::Matches(
                (Get-Content $file.FullName -Raw),
                '(?:import|from)\s+[''"](\.\.?/[^''"]+)[''"]'
            )
            foreach ($m in $matches) {
                $relPath = $m.Groups[1].Value
                $dir = Split-Path $file.FullName -Parent
                # Try .ts, .js extensions
                $resolved = @(
                    (Join-Path $dir "$relPath.ts"),
                    (Join-Path $dir "$relPath.js"),
                    (Join-Path $dir "$relPath")
                )
                foreach ($candidate in $resolved) {
                    $rp = Resolve-Path $candidate -ErrorAction SilentlyContinue
                    $normalized = if ($rp) { $rp.Path } else { $null }
                    if ($normalized) {
                        $AllImports += $normalized
                        break
                    }
                }
            }
        }

        # Check each .ts file in src/ is imported somewhere (except entry point)
        $entryPoint = (Resolve-Path "$RepoRoot\src\index.ts").Path
        $deadFiles = @()
        foreach ($file in $SrcFiles) {
            if ($file.FullName -eq $entryPoint) { continue }
            if ($AllImports -notcontains $file.FullName) {
                $deadFiles += $file.FullName.Replace($RepoRoot, "")
            }
        }

        if ($deadFiles.Count -gt 0) {
            Write-Fail "Unreferenced source files found:"
            $deadFiles | ForEach-Object { Write-Info "  $_" }
            Record-Result "deadcode" $false ($deadFiles -join ", ")
        } else {
            Write-Ok "No dead source files"
            Record-Result "deadcode" $true
        }
    } catch {
        Write-Fail "Dead code check error"
        Record-Result "deadcode" $false $_
    }
}

function Step-PackageJson {
    Write-Step "Validating package.json"
    try {
        $pkg = Get-Content "$RepoRoot\package.json" -Raw | ConvertFrom-Json
        $issues = @()

        if ($pkg.author -eq "Your Name") { $issues += "author is placeholder" }
        if ($pkg.repository.url -match "yourusername") { $issues += "repository URL is placeholder" }
        if ($pkg.bugs.url -match "yourusername") { $issues += "bugs URL is placeholder" }
        if ($pkg.homepage -match "yourusername") { $issues += "homepage URL is placeholder" }

        if ($issues.Count -gt 0) {
            throw ($issues -join "; ")
        }

        Write-Ok "package.json is valid"
        Record-Result "packagejson" $true
    } catch {
        Write-Fail "package.json issues: $_"
        Record-Result "packagejson" $false $_
    }
}

# ── Main ──────────────────────────────────────────────────────────────────────
try {
    $FromVersion = if ($OriginalVersion) { $OriginalVersion } else { "unknown" }
    Write-Step "Switching Node from $FromVersion to $TargetVersion"
    nvm use $TargetRaw *>&1 | Out-Null

    Write-Step "Environment"
    Write-Info "Node: $(node -v)"
    Write-Info "npm:  $(npm -v)"

    # Default steps: all
    if ($args.Count -eq 0) {
        $steps = @("lint", "typecheck", "build", "deadcode", "packagejson", "test")
    } else {
        $steps = $args
    }

    foreach ($step in $steps) {
        switch ($step) {
            "lint"      { Step-Lint }
            "typecheck" { Step-TypeCheck }
            "build"     { Step-Build }
            "test"      { Step-Test }
            "deadcode"  { Step-DeadCode }
            "packagejson" { Step-PackageJson }
            default {
                Write-Fail "Unknown step '$step'."
                Write-Host "Supported steps: lint typecheck build test deadcode packagejson"
                exit 1
            }
        }
    }

    # ── Summary ───────────────────────────────────────────────────────────────
    Write-Host ""
    Write-Host "==================== Pre-Publish Test Summary ====================" -ForegroundColor Cyan
    $passCount = ($Results | Where-Object { $_.Success }).Count
    $failCount = ($Results | Where-Object { -not $_.Success }).Count
    foreach ($r in $Results) {
        if ($r.Success) {
            Write-Host ("  PASS  {0,-14} {1}" -f $r.Step, $r.Detail) -ForegroundColor Green
        } else {
            Write-Host ("  FAIL  {0,-14} {1}" -f $r.Step, $r.Detail) -ForegroundColor Red
        }
    }
    Write-Host ""
    Write-Host ("  {0} passed, {1} failed" -f $passCount, $failCount) -ForegroundColor $(if ($failCount -gt 0) { "Red" } else { "Green" })
    Write-Host "===================================================================" -ForegroundColor Cyan

    if ($Failed) {
        Write-Host ""
        Write-Fail "Pre-publish checks FAILED. Do not publish."
        exit 1
    } else {
        Write-Host ""
        Write-Ok "All pre-publish checks passed. Ready to publish!"
        exit 0
    }
} finally {
    Restore-Node
}
