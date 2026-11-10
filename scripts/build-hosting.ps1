$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$dotnet = Join-Path $projectRoot '.tools/dotnet/dotnet.exe'
$output = Join-Path $projectRoot '.tools/hosting/server'
$env:DOTNET_CLI_HOME = Join-Path $projectRoot '.tools/dotnet-home'
$env:NUGET_PACKAGES = Join-Path $projectRoot '.cache/nuget'
. (Join-Path $PSScriptRoot 'build-state.ps1')
$buildInputs = Start-ShronchikBuildState -ProjectRoot $projectRoot -Mode Hosting
Push-Location (Join-Path $projectRoot 'src/Shronchik.Web')
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
}
finally { Pop-Location }
$serverProject = Join-Path $projectRoot 'src/Shronchik.Server/Shronchik.Server.csproj'
$nugetConfig = Join-Path $projectRoot 'NuGet.Config'
# Hash changes can have older timestamps; force compilation before publishing.
& $dotnet build $serverProject -c Release --no-incremental "-p:RestoreConfigFile=$nugetConfig" -m:1 -p:UseSharedCompilation=false
if ($LASTEXITCODE -ne 0) { throw 'Hosting build failed.' }
& $dotnet publish $serverProject -c Release --no-build --no-restore -m:1 -p:UseSharedCompilation=false -o $output
if ($LASTEXITCODE -ne 0) { throw 'Hosting publish failed.' }
Save-ShronchikBuildState -ProjectRoot $projectRoot -Mode Hosting -InputFingerprint $buildInputs
Write-Output $output
