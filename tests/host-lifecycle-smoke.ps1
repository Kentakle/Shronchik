# Separate Windows smoke test: requires a built server and the local Caddy binary.
# It never opens a public listener or requests a certificate.
param(
    [switch]$Worker,
    [string]$TaskRoot = '',
    [int]$ServerPort = 0,
    [int]$ProxyPort = 0
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$dotnet = Join-Path $projectRoot '.tools/dotnet/dotnet.exe'
if (-not (Test-Path -LiteralPath $dotnet)) { $dotnet = (Get-Command dotnet -CommandType Application -ErrorAction Stop).Source }
$serverRoot = Join-Path $projectRoot '.tools/hosting/server'
$serverDll = Join-Path $serverRoot 'Shronchik.Server.dll'
if (-not (Test-Path -LiteralPath $serverDll)) {
    $serverRoot = Join-Path $projectRoot 'src/Shronchik.Server'
    $serverDll = Join-Path $serverRoot 'bin/Debug/net10.0/Shronchik.Server.dll'
}
$caddy = Join-Path $projectRoot '.tools/caddy/2.11.9/caddy.exe'
foreach ($file in @($serverDll, $caddy)) {
    if (-not (Test-Path -LiteralPath $file)) { throw "Build the server and install Caddy before this optional test. Missing: $file" }
}

if ($Worker) {
    $cacheRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.cache')) + [IO.Path]::DirectorySeparatorChar
    $TaskRoot = [IO.Path]::GetFullPath($TaskRoot)
    if (-not $TaskRoot.StartsWith($cacheRoot, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path $TaskRoot -Leaf) -notlike 'host-lifecycle-*' -or $ServerPort -lt 1024 -or $ProxyPort -lt 1024) {
        throw 'Worker requires an isolated .cache/host-lifecycle-* directory and test ports.'
    }
    . (Join-Path $projectRoot 'scripts/process-scope.ps1')
    $env:SHRONCHIK_PORT = [string]$ServerPort
    $env:SHRONCHIK_PUBLIC_ORIGIN = ''
    $env:SHRONCHIK_LIBRARY = Join-Path $TaskRoot 'library'
    $env:SHRONCHIK_STORAGE_CONFIG = Join-Path $TaskRoot 'library.location.json'
    $scope = [Shronchik.Hosting.ProcessScope]::new()
    $shell = (Get-Command powershell.exe -CommandType Application).Source
    $probe = $scope.Start($shell,
        '-NoProfile -Command "[Console]::Out.WriteLine(''SCOPE_STDOUT_SENTINEL''); [Console]::Error.WriteLine(''SCOPE_STDERR_SENTINEL''); exit 7"',
        $TaskRoot, $null, $null)
    if (-not $probe.WaitForExit(10000) -or $probe.ExitCode -ne 7) { throw 'Child exit code was not preserved.' }
    $probe.Dispose()
    $server = $scope.Start($dotnet, ('"' + $serverDll + '"'), $serverRoot,
        (Join-Path $TaskRoot 'server.log'), (Join-Path $TaskRoot 'server.error.log'))
    $proxy = $scope.Start($caddy,
        ('run --config "' + (Join-Path $TaskRoot 'Caddyfile') + '" --adapter caddyfile'),
        $TaskRoot, (Join-Path $TaskRoot 'caddy.log'), (Join-Path $TaskRoot 'caddy.error.log'))
    @{ server = $server.Id; proxy = $proxy.Id } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $TaskRoot 'pids.json')
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not (Test-Path -LiteralPath (Join-Path $TaskRoot 'exit.signal')) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 100
    }
    # Deliberately skip Dispose/finally: only OS closure of the parent's job
    # handle can kill the children, as when the hosting console is closed.
    [Environment]::Exit(0)
}

$TaskRoot = Join-Path $projectRoot ('.cache/host-lifecycle-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TaskRoot | Out-Null
$listeners = @()
try {
    foreach ($unused in 1..2) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $listeners += $listener
    }
    $ServerPort = $listeners[0].LocalEndpoint.Port
    $ProxyPort = $listeners[1].LocalEndpoint.Port
}
finally { foreach ($listener in $listeners) { $listener.Stop() } }
@"
{
    admin off
    auto_https off
}
http://127.0.0.1:$ProxyPort {
    reverse_proxy 127.0.0.1:$ServerPort {
        header_up Host 127.0.0.1:$ServerPort
    }
}
"@ | Set-Content -LiteralPath (Join-Path $TaskRoot 'Caddyfile')
$workerProcess = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'),
    '-Worker', '-TaskRoot', ('"' + $TaskRoot + '"'), '-ServerPort', $ServerPort, '-ProxyPort', $ProxyPort
) -RedirectStandardOutput (Join-Path $TaskRoot 'worker.log') -RedirectStandardError (Join-Path $TaskRoot 'worker.error.log')
$childIds = $null
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($workerProcess.HasExited) {
            throw ('Worker exited early: ' + (Get-Content -LiteralPath (Join-Path $TaskRoot 'worker.error.log') -Raw))
        }
        try {
            $health = Invoke-WebRequest -Uri "http://127.0.0.1:$ProxyPort/api/v1/health" -UseBasicParsing -TimeoutSec 1
            if ($health.StatusCode -eq 200 -and (Test-Path -LiteralPath (Join-Path $TaskRoot 'pids.json'))) {
                $ready = $true
                break
            }
        } catch { }
        Start-Sleep -Milliseconds 100
    }
    if (-not $ready) { throw "Server/proxy not ready. Logs: $TaskRoot" }
    $childIds = Get-Content -LiteralPath (Join-Path $TaskRoot 'pids.json') -Raw | ConvertFrom-Json
    foreach ($childId in @($childIds.server, $childIds.proxy)) {
        if (-not (Get-Process -Id $childId -ErrorAction SilentlyContinue)) { throw 'Test child exited before parent.' }
    }
}
finally {
    Set-Content -LiteralPath (Join-Path $TaskRoot 'exit.signal') -Value 'exit'
    if (-not $workerProcess.WaitForExit(30000)) { throw "Test worker failed to exit. Logs: $TaskRoot" }
    $workerProcess.Dispose()
}
Start-Sleep -Milliseconds 500
foreach ($childId in @($childIds.server, $childIds.proxy)) {
    if (Get-Process -Id $childId -ErrorAction SilentlyContinue) { throw "Child process survived parent exit: $childId" }
}
foreach ($testPort in @($ServerPort, $ProxyPort)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $testPort -ErrorAction SilentlyContinue) { throw "Test port remains occupied: $testPort" }
}
if ((Get-Content -LiteralPath (Join-Path $TaskRoot 'worker.log') -Raw) -notmatch 'SCOPE_STDOUT_SENTINEL' -or
    (Get-Content -LiteralPath (Join-Path $TaskRoot 'worker.error.log') -Raw) -notmatch 'SCOPE_STDERR_SENTINEL') {
    throw "Child stdout/stderr did not reach the launcher's inherited handles. Logs: $TaskRoot"
}
Write-Host 'PASS: inherited stdout/stderr and child exit code preserved.'
Write-Host 'PASS: parent exit without cleanup killed server and proxy; loopback test ports released.'
Write-Host "Synthetic library and logs: $TaskRoot"
