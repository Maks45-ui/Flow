[CmdletBinding()]
param(
    [switch]$Signed,
    [ValidateRange(1, 5)][int]$MaxAttempts = 3,
    [ValidateRange(0, 60)][int]$RetryDelaySeconds = 15
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$buildArguments = @('tauri', 'build', '--bundles', 'nsis')
if ($Signed) {
    $buildArguments += @('--config', 'src-tauri/tauri.updater.conf.json')
}

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    & pnpm @buildArguments 2>&1 | Tee-Object -Variable buildLog | Out-Host
    $buildExitCode = $LASTEXITCODE
    if ($buildExitCode -eq 0) { return }

    # Retry only transient download failures. Compilation, signing and hash
    # validation errors must still fail immediately. Tauri reuses downloaded
    # tools and Cargo output on the same runner on subsequent attempts.
    $isTransientDownload = ($buildLog -join "`n") -match '(?i)(http status:\s*`?\s*(429|5\d{2})\b|unexpected http response:\s*(429|5\d{2})\b|connection (timed out|reset)|dns error|failed to lookup address)'
    if (-not $isTransientDownload -or $attempt -eq $MaxAttempts) {
        throw "Windows installer build failed with exit code $buildExitCode (attempt $attempt/$MaxAttempts)."
    }

    Write-Warning "Temporary download failure; retrying installer build ($attempt/$MaxAttempts) in $RetryDelaySeconds seconds."
    Start-Sleep -Seconds $RetryDelaySeconds
}
