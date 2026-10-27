# SadakatKarti-ni lokal Hesabatım bazası ilə işə salır: http://localhost:3100
# Əvvəlcə Hesabatım backend-i işləməlidir (E:\hesabatim\start-backend.ps1, port 8000).
param(
    [string]$Business = 'cybernet-llc',   # Hesabatım-dakı biznesin slug-u
    [int]$Port = 3100
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$secretLine = Get-Content -LiteralPath 'E:\hesabatim\backend\.env' -ErrorAction SilentlyContinue |
    Where-Object { $_ -match '^PROXY_SECRET=' } | Select-Object -First 1
$env:HESABATIM_PROXY_SECRET = if ($secretLine) { $secretLine.Substring(13) } else { '' }
$env:HESABATIM_API_URL = 'http://127.0.0.1:8000/api/v1'
$env:HESABATIM_BUSINESS = $Business
$env:PORT = "$Port"
Remove-Item Env:DATABASE_URL, Env:POSTGRES_URL -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath 'dist\node\src\server\index.js')) {
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build alınmadı' }
}
node --no-warnings dist/node/src/server/index.js
