param(
    [string]$PublicIP = '',
    [ValidateRange(1024,65535)][int]$Port = 5271,
    [string]$LibraryPath = '',
    [switch]$NoBuild,
    [switch]$Rebuild
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (-not $PublicIP) {
    $configPath = Join-Path $projectRoot 'data/hosting/Caddyfile'
    if (-not (Test-Path -LiteralPath $configPath)) {
        throw 'No saved public IPv4 address. Run Start-Shronchik-Host.bat -PublicIP YOUR_PUBLIC_IP first.'
    }
    $savedConfig = Get-Content -LiteralPath $configPath -Raw
    $savedAddress = [regex]::Match($savedConfig, '(?m)^https://([0-9.]+)\s*\{')
    if (-not $savedAddress.Success) { throw 'No public IPv4 address found in data/hosting/Caddyfile. Supply -PublicIP.' }
    $PublicIP = $savedAddress.Groups[1].Value
    if (-not $PSBoundParameters.ContainsKey('Port')) {
        $savedPort = [regex]::Match($savedConfig, '(?m)^\s*reverse_proxy 127\.0\.0\.1:([0-9]+)\s*\{')
        if ($savedPort.Success) { $Port = [int]$savedPort.Groups[1].Value }
    }
}
# Refuse before rebuilding or changing configuration for an already running host.
$busyPorts = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 80,443,$Port,2019 })
if ($busyPorts.Count) {
    $listeners = @($busyPorts | Sort-Object LocalPort,OwningProcess -Unique | ForEach-Object {
        $owner = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
        $ownerName = if ($owner) { $owner.ProcessName } else { 'unknown process' }
        '{0}: {1} (PID {2})' -f $_.LocalPort, $ownerName, $_.OwningProcess
    })
    throw ('Stop existing listeners before HTTPS launch. Busy ports: ' + ($listeners -join ', ') +
        '. Close the local Shronchik window (Start-Shronchik.cmd) or the previous HTTPS host, then retry. ' +
        'Local and HTTPS instances cannot use the same library simultaneously.')
}
$prepared = & (Join-Path $PSScriptRoot 'prepare-https.ps1') -PublicIP $PublicIP -Port $Port
$libraryRoot = if ($LibraryPath) { [IO.Path]::GetFullPath($LibraryPath) } else { Join-Path $projectRoot 'data/library' }
$env:SHRONCHIK_STORAGE_CONFIG = $libraryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + '.location.json'
if (Test-Path -LiteralPath $env:SHRONCHIK_STORAGE_CONFIG) {
    $location = Get-Content -LiteralPath $env:SHRONCHIK_STORAGE_CONFIG -Raw | ConvertFrom-Json
    if (-not $location.libraryRoot -or [string]$location.libraryRoot -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') {
        throw 'Invalid saved library location.'
    }
    $libraryRoot = [IO.Path]::GetFullPath([string]$location.libraryRoot)
}
$dotnet = Join-Path $projectRoot '.tools/dotnet/dotnet.exe'
$serverRoot = Join-Path $projectRoot '.tools/hosting/server'
$serverDll = Join-Path $serverRoot 'Shronchik.Server.dll'
$webIndex = Join-Path $serverRoot 'wwwroot/index.html'
. (Join-Path $PSScriptRoot 'build-state.ps1')
if (Test-ShronchikBuildNeeded -ProjectRoot $projectRoot -Mode Hosting -NoBuild:$NoBuild -Rebuild:$Rebuild) {
    Write-Host 'Building current HTTPS version...'
    & (Join-Path $PSScriptRoot 'build-hosting.ps1') | Out-Host
}
foreach ($file in @($dotnet, $serverDll, (Join-Path $libraryRoot 'library.json'))) {
    if (-not (Test-Path -LiteralPath $file)) { throw "Required file is missing: $file" }
}
$identity = Get-Content -LiteralPath (Join-Path $libraryRoot 'library.json') -Raw | ConvertFrom-Json
$weak = @($identity.accounts.PSObject.Properties | Where-Object {
    $_.Name -ne 'Admin' -and $_.Value.enabled -ne $false -and $_.Value.weakPassword -eq $true
} | ForEach-Object Name)
if ($weak.Count) { throw ('Change passwords to 12+ characters or disable these accounts first: ' + ($weak -join ', ')) }
$env:DOTNET_CLI_HOME = Join-Path $projectRoot '.tools/dotnet-home'
$env:NUGET_PACKAGES = Join-Path $projectRoot '.cache/nuget'
$env:SHRONCHIK_PORT = [string]$Port
$env:SHRONCHIK_LIBRARY = $libraryRoot
$env:SHRONCHIK_PUBLIC_ORIGIN = $prepared.PublicOrigin
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
. (Join-Path $PSScriptRoot 'process-scope.ps1')
$scope = [Shronchik.Hosting.ProcessScope]::new()
$server = $null
$proxy = $null
try {
    $server = $scope.Start($dotnet, ('"' + $serverDll + '"'), $serverRoot,
        (Join-Path $prepared.HostingRoot "server-$stamp.log"),
        (Join-Path $prepared.HostingRoot "server-$stamp.error.log"))
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($server.HasExited) { throw 'Shronchik exited. Check its hosting log.' }
        try {
            $health = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/v1/health" -UseBasicParsing -TimeoutSec 1
            if ($health.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'Shronchik did not become ready.' }
    Write-Host "Shronchik HTTPS: $($prepared.PublicOrigin)"
    Write-Host "Admin (this computer only): http://127.0.0.1:$Port"
    Write-Host 'Router TCP 80 and 443 must point to this computer.'
    Write-Host 'Close this window or press Ctrl+C to stop both the host and HTTPS proxy.'
    $proxy = $scope.Start($prepared.Caddy,
        ('run --config "' + $prepared.Config + '" --adapter caddyfile'), $prepared.HostingRoot, $null, $null)
    while (-not $proxy.WaitForExit(250)) {
        if ($server.HasExited) { throw 'Shronchik exited. Check its hosting log.' }
    }
    if ($proxy.ExitCode -ne 0) { throw "Caddy stopped with code $($proxy.ExitCode)." }
}
finally {
    $scope.Dispose()
    if ($null -ne $proxy) { $proxy.Dispose() }
    if ($null -ne $server) { $server.Dispose() }
}
