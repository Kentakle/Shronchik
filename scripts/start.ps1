param(
    [int]$Port = 5271,
    [string]$LibraryPath = '',
    [string]$PublicOrigin = $env:SHRONCHIK_PUBLIC_ORIGIN,
    [switch]$NoBuild,
    [switch]$Rebuild
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$localDotnet = Join-Path $projectRoot '.tools/dotnet/dotnet.exe'
$dotnetCommand = if (Test-Path -LiteralPath $localDotnet) { $localDotnet } else { 'dotnet' }
$env:DOTNET_CLI_HOME = Join-Path $projectRoot '.tools/dotnet-home'
$env:NUGET_PACKAGES = Join-Path $projectRoot '.cache/nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:SHRONCHIK_PORT = [string]$Port
$env:SHRONCHIK_PUBLIC_ORIGIN = $PublicOrigin
$env:SHRONCHIK_LIBRARY = if ($LibraryPath) { [IO.Path]::GetFullPath($LibraryPath) } else { Join-Path $projectRoot 'data/library' }
$env:SHRONCHIK_STORAGE_CONFIG = $env:SHRONCHIK_LIBRARY.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + '.location.json'
$serverRoot = Join-Path $projectRoot 'src/Shronchik.Server'
$serverDll = Join-Path $serverRoot 'bin/Debug/net10.0/Shronchik.Server.dll'
$webIndex = Join-Path $serverRoot 'wwwroot/index.html'
. (Join-Path $PSScriptRoot 'build-state.ps1')
$shouldBuild = Test-ShronchikBuildNeeded -ProjectRoot $projectRoot -Mode Debug -NoBuild:$NoBuild -Rebuild:$Rebuild
Push-Location $projectRoot
try {
    if ($shouldBuild) {
        Write-Host 'Building current local version...'
        $buildInputs = Start-ShronchikBuildState -ProjectRoot $projectRoot -Mode Debug
        $nugetConfig = Join-Path $projectRoot 'NuGet.Config'
        & $dotnetCommand build (Join-Path $serverRoot 'Shronchik.Server.csproj') --no-incremental "-p:RestoreConfigFile=$nugetConfig" -m:1 -p:UseSharedCompilation=false
        if ($LASTEXITCODE -ne 0) { throw 'Server build failed. Install the .NET 10 SDK and try again.' }
        Push-Location (Join-Path $projectRoot 'src/Shronchik.Web')
        try {
            if (-not (Test-Path -LiteralPath 'node_modules')) {
                & npm.cmd ci --no-fund --no-audit
                if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
            }
            & npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
        }
        finally { Pop-Location }
        Save-ShronchikBuildState -ProjectRoot $projectRoot -Mode Debug -InputFingerprint $buildInputs
    }
    if (-not (Test-Path -LiteralPath $webIndex) -or -not (Test-Path -LiteralPath $serverDll)) { throw 'Build missing. Run without -NoBuild.' }
    . (Join-Path $PSScriptRoot 'process-scope.ps1')
    $executable = (Get-Command $dotnetCommand -CommandType Application -ErrorAction Stop).Source
    Write-Host "Shronchik: http://127.0.0.1:$Port  |  Close this window or press Ctrl+C to stop"
    $scope = [Shronchik.Hosting.ProcessScope]::new()
    $server = $null
    try {
        $server = $scope.Start($executable, ('"' + $serverDll + '"'), $serverRoot, $null, $null)
        while (-not $server.WaitForExit(250)) { }
        if ($server.ExitCode -ne 0) { throw "Shronchik exited with code $($server.ExitCode)." }
    }
    finally {
        $scope.Dispose()
        if ($null -ne $server) { $server.Dispose() }
    }
}
finally { Pop-Location }
