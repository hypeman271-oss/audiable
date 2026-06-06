# Safe deploy wrapper (#795).
#
# Runs the pre-deploy guard (scripts/predeploy_check.ps1) and then
# invokes `fly deploy`. Refuses to deploy if any in-flight synth jobs
# are detected — a rolling restart mid-synth has produced duplicate
# clips (see v225v4.3 → v225v4.4 incident).
#
# Usage:
#   scripts/deploy.ps1
#       Check, then deploy if clear.
#   scripts/deploy.ps1 -Force
#       Skip the check. Use only if you know what you're doing
#       (eg the synth is genuinely stuck and you want to clear it
#       by deploying anyway).
#   scripts/deploy.ps1 -AppHost mystaging.fly.dev
#       Target a different deployment for the check.
#
# Any extra args after -- are passed through to `fly deploy`:
#   scripts/deploy.ps1 -- --strategy immediate

param(
    [switch]$Force,
    [string]$AppHost = "narrative-alpha.fly.dev",
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$FlyArgs
)

if (-not $Force) {
    & "$PSScriptRoot/predeploy_check.ps1" -AppHost $AppHost
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "Refusing to deploy." -ForegroundColor Red
        exit $LASTEXITCODE
    }
} else {
    Write-Host "WARNING: -Force skips the in-flight synth check." -ForegroundColor Yellow
    Write-Host "         A deploy now may produce duplicate clips." -ForegroundColor Yellow
    Write-Host ""
}

Write-Host "Running fly deploy ..." -ForegroundColor Cyan
if ($FlyArgs) {
    fly deploy @FlyArgs
} else {
    fly deploy
}
exit $LASTEXITCODE
