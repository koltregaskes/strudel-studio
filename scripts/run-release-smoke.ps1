$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$repoRoot = Split-Path -Parent $PSScriptRoot
$baseUrl = 'http://127.0.0.1:8031/'
$edgeCandidates = @(
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Google\Chrome\Application\chrome.exe'
)
$browserPath = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $browserPath) {
    throw 'Could not find a supported Chromium browser (Edge or Chrome).'
}

function Wait-ForUrl {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 15
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
            if ($response.StatusCode -eq 200) {
                return
            }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }

    throw "Timed out waiting for $Url"
}

$startedServer = $false
$serverProcess = $null
$domDumpPath = Join-Path $env:TEMP "strudel-release-smoke-dom-$([guid]::NewGuid().ToString('N')).html"

try {
    try {
        $rootResponse = Invoke-WebRequest -UseBasicParsing -Uri $baseUrl -TimeoutSec 3
        if ($rootResponse.StatusCode -ne 200) {
            throw 'Local root endpoint did not return 200.'
        }
    } catch {
        $serverProcess = Start-Process -FilePath python -ArgumentList '-m','http.server','8031','--bind','127.0.0.1' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
        $startedServer = $true
        Wait-ForUrl -Url $baseUrl -TimeoutSeconds 15
    }

    $manifestResponse = Invoke-WebRequest -UseBasicParsing -Uri "${baseUrl}manifest.webmanifest" -TimeoutSec 5
    $swResponse = Invoke-WebRequest -UseBasicParsing -Uri "${baseUrl}sw.js" -TimeoutSec 5
    if ($manifestResponse.StatusCode -ne 200) {
        throw 'Manifest check failed.'
    }
    if ($swResponse.StatusCode -ne 200) {
        throw 'Service worker check failed.'
    }

    $smokeUrl = "${baseUrl}?release-smoke=1&ts=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    $edgeCommand = "`"$browserPath`" --headless --disable-gpu --autoplay-policy=no-user-gesture-required --virtual-time-budget=30000 --dump-dom `"$smokeUrl`" > `"$domDumpPath`" 2>nul"
    cmd /c $edgeCommand | Out-Null

    $domDump = Get-Content -Raw -Path $domDumpPath
    $match = [regex]::Match($domDump, '<script[^>]*id="releaseSmokeResult"[^>]*>(.*?)</script>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if (-not $match.Success) {
        throw 'Could not find release smoke result in dumped DOM.'
    }

    $payload = $match.Groups[1].Value | ConvertFrom-Json
    if ($payload.status -ne 'pass') {
        throw "Release smoke failed: $($payload.error)"
    }

    Write-Host 'Strudel Studio release smoke passed.'
    $payload.summary | ConvertTo-Json -Depth 8
} finally {
    if ($startedServer -and $serverProcess) {
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $domDumpPath -Force -ErrorAction SilentlyContinue
}
