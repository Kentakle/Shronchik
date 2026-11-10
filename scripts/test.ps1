$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$localDotnet = Join-Path $projectRoot '.tools/dotnet/dotnet.exe'
$dotnetCommand = if (Test-Path -LiteralPath $localDotnet) { $localDotnet } else { 'dotnet' }
$env:DOTNET_CLI_HOME = Join-Path $projectRoot '.tools/dotnet-home'
$env:NUGET_PACKAGES = Join-Path $projectRoot '.cache/nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
. (Join-Path $PSScriptRoot 'build-state.ps1')
Push-Location $projectRoot
try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot 'tests/build-freshness-smoke.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Build freshness checks failed.' }
    $nugetConfig = Join-Path $projectRoot 'NuGet.Config'
    & $dotnetCommand build Shronchik.slnx "-p:RestoreConfigFile=$nugetConfig" -m:1 -p:UseSharedCompilation=false
    if ($LASTEXITCODE -ne 0) { throw 'Build failed. Stop a running server before testing.' }
    foreach ($testProject in @('Shronchik.Core.Tests', 'Shronchik.Catalog.Tests', 'Shronchik.Session.Tests')) {
        & $dotnetCommand (Join-Path $projectRoot "tests/$testProject/bin/Debug/net10.0/$testProject.dll")
        if ($LASTEXITCODE -ne 0) { throw "$testProject failed." }
    }
    Build-ShronchikWeb -ProjectRoot $projectRoot
    & node tests/http-smoke.mjs
    if ($LASTEXITCODE -ne 0) { throw 'HTTP smoke failed.' }
    & node tests/security-smoke.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Security smoke failed.' }
    & node tests/storage-smoke.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Storage smoke failed.' }
}
finally { Pop-Location }
