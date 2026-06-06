# Pre-deploy guard (#795).
#
# Checks the production server for in-flight synth jobs and refuses to
# proceed if any are active. A rolling `fly deploy` mid-synth has
# produced duplicate clips in practice (v225v4.3 → v225v4.4 incident:
# bg-queue synth was running when v4.4 deployed; the resumption logic
# added a second clip with identical text/duration/voice instead of
# resuming the first).
#
# Fail-safe: blocks the deploy if the server is unreachable or the
# admin bearer is missing. Use scripts/deploy.ps1 -Force to override.
#
# Usage:
#   scripts/predeploy_check.ps1
#       Hits narrative-alpha.fly.dev by default.
#   scripts/predeploy_check.ps1 -AppHost mystaging.fly.dev
#       Targets a different deployment.
#
# Exit codes:
#   0 - safe to deploy (no active jobs)
#   1 - blocked: jobs in flight; details printed
#   2 - blocked: could not check (missing key, unreachable server, etc.)

param(
    [string]$AppHost = "narrative-alpha.fly.dev"
)

if (-not $env:NARRATIVE_KEY) {
    Write-Host "FAIL: NARRATIVE_KEY env var not set." -ForegroundColor Red
    Write-Host "      Admin bearer is required to check job state." -ForegroundColor Red
    Write-Host "      Run scripts/deploy.ps1 -Force to skip this check." -ForegroundColor Yellow
    exit 2
}

$url = "https://$AppHost/api/admin/synth-jobs/active"
Write-Host "Checking $url ..." -ForegroundColor Cyan

try {
    $resp = Invoke-RestMethod `
        -Uri $url `
        -Headers @{ "X-Narrative-Key" = $env:NARRATIVE_KEY } `
        -TimeoutSec 15 `
        -ErrorAction Stop
} catch {
    Write-Host "FAIL: could not reach $url" -ForegroundColor Red
    Write-Host "      $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "      Run scripts/deploy.ps1 -Force to skip this check." -ForegroundColor Yellow
    exit 2
}

if ($null -eq $resp.count) {
    Write-Host "FAIL: unexpected response shape from server." -ForegroundColor Red
    Write-Host "      $(($resp | ConvertTo-Json -Depth 4))" -ForegroundColor Red
    exit 2
}

if ($resp.count -eq 0) {
    Write-Host "OK: no in-flight synth jobs. Safe to deploy." -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "BLOCK: $($resp.count) in-flight synth job(s)" -ForegroundColor Yellow
Write-Host ""
foreach ($job in $resp.active) {
    $progress = "{0}/{1}" -f $job.sentences_done, $job.sentences_total
    $elapsed = "{0:N1}s" -f $job.elapsed_sec
    $tenant = if ($job.tenant_key) { $job.tenant_key.Substring(0, [Math]::Min(12, $job.tenant_key.Length)) + "..." } else { "(local)" }
    Write-Host ("  - job={0}  status={1}  progress={2}  elapsed={3}  tenant={4}" -f `
        $job.id.Substring(0, [Math]::Min(8, $job.id.Length)), `
        $job.status, $progress, $elapsed, $tenant)
}
Write-Host ""
Write-Host "Wait for these to finish (typically a few minutes), then re-run." -ForegroundColor Yellow
Write-Host "Or run scripts/deploy.ps1 -Force to override (will produce duplicate clips)." -ForegroundColor Yellow
exit 1
