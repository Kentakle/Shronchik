# Isolated regression: no real build, public listener, or user library access.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $projectRoot 'scripts/build-state.ps1')
$fixtureRoot = Join-Path $projectRoot ('.cache/build-freshness-' + [guid]::NewGuid().ToString('N'))
$script:checks = 0
function Assert-Freshness {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
    $script:checks++
}
function Write-FixtureFile {
    param([string]$RelativePath, [string]$Content = 'fixture')
    $path = Join-Path $fixtureRoot $RelativePath
    [IO.Directory]::CreateDirectory((Split-Path $path -Parent)) | Out-Null
    [IO.File]::WriteAllText($path, $Content)
}
function Save-FixtureBuild {
    param([string]$Mode)
    $fingerprint = Start-ShronchikBuildState -ProjectRoot $fixtureRoot -Mode $Mode
    Save-ShronchikBuildState -ProjectRoot $fixtureRoot -Mode $Mode -InputFingerprint $fingerprint
}
function Test-FixtureCurrent {
    param([string]$Mode = 'Debug')
    Test-ShronchikBuildCurrent -ProjectRoot $fixtureRoot -Mode $Mode
}

foreach ($source in @('src/Shronchik.Core/Code.cs', 'src/Shronchik.Server/Program.cs', 'src/Shronchik.Web/src/App.tsx',
    'src/Shronchik.Web/package-lock.json', 'src/Shronchik.Web/vite.config.ts', 'global.json', 'NuGet.Config',
    'scripts/build-state.ps1', 'scripts/build-hosting.ps1', 'scripts/start.ps1', 'scripts/start-https.ps1')) {
    Write-FixtureFile $source
}
Write-FixtureFile 'shared/tags.json' '{"version":2,"tags":["Asia"]}'
foreach ($mode in @('Debug', 'Hosting')) {
    $binaryPath = 'src/Shronchik.Server/bin/Debug/net10.0'
    $webPath = 'src/Shronchik.Server/wwwroot'
    if ($mode -eq 'Hosting') { $binaryPath = '.tools/hosting/server'; $webPath = $binaryPath + '/wwwroot' }
    foreach ($name in @('Shronchik.Server.dll', 'Shronchik.Core.dll', 'Shronchik.Server.deps.json', 'Shronchik.Server.runtimeconfig.json')) {
        Write-FixtureFile ($binaryPath + '/' + $name)
    }
    Write-FixtureFile ($binaryPath + '/tags.json') '{"version":2,"tags":["Asia"]}'
    Write-FixtureFile ($webPath + '/index.html') '<script src="/assets/app.js"></script><link href="/assets/style.css">'
    Write-FixtureFile ($webPath + '/assets/app.js') 'new tags'
    Write-FixtureFile ($webPath + '/assets/style.css') 'body{}'
}

Assert-Freshness (-not (Test-FixtureCurrent)) 'Unstamped output was trusted.'
Assert-Freshness (Test-ShronchikBuildNeeded -ProjectRoot $fixtureRoot -Mode Debug) 'Cold launch did not request a build.'
Assert-Freshness (-not (Test-ShronchikBuildNeeded -ProjectRoot $fixtureRoot -Mode Debug -NoBuild)) '-NoBuild did not bypass a cold build.'
Assert-Freshness (Test-ShronchikBuildNeeded -ProjectRoot $fixtureRoot -Mode Debug -NoBuild -Rebuild) '-Rebuild must override -NoBuild.'
Save-FixtureBuild Debug
Assert-Freshness (Test-FixtureCurrent) 'Complete Debug build was not recognized.'
Assert-Freshness (-not (Test-FixtureCurrent Hosting)) 'Debug stamp refreshed Hosting.'
Save-FixtureBuild Hosting
Assert-Freshness (Test-FixtureCurrent Hosting) 'Complete Hosting build was not recognized.'
Assert-Freshness (-not (Test-ShronchikBuildNeeded -ProjectRoot $fixtureRoot -Mode Debug)) 'Unchanged launch requested a rebuild.'
Assert-Freshness (Test-ShronchikBuildNeeded -ProjectRoot $fixtureRoot -Mode Debug -Rebuild) '-Rebuild did not rebuild current output.'

# Generated outputs and dependency trees do not become source inputs.
foreach ($excluded in @('src/Shronchik.Web/node_modules/dep/index.js', 'src/Shronchik.Server/obj/cache.json',
    'src/Shronchik.Core/bin/Release/ignored.dll', 'src/Shronchik.Web/tsconfig.tsbuildinfo')) {
    Write-FixtureFile $excluded 'ignored'
}
Assert-Freshness (Test-FixtureCurrent) 'Generated/dependency files changed the source fingerprint.'
(Get-Item -LiteralPath (Join-Path $fixtureRoot 'src/Shronchik.Server/Program.cs')).LastWriteTimeUtc = [DateTime]::UtcNow.AddYears(-2)
Assert-Freshness (Test-FixtureCurrent) 'Timestamp-only change caused a rebuild.'
Write-FixtureFile 'src/Shronchik.Server/Program.cs' 'changed but backdated'
(Get-Item -LiteralPath (Join-Path $fixtureRoot 'src/Shronchik.Server/Program.cs')).LastWriteTimeUtc = [DateTime]::UtcNow.AddYears(-3)
Assert-Freshness (-not (Test-FixtureCurrent)) 'Backdated source change was missed.'
Assert-Freshness (-not (Test-FixtureCurrent Hosting)) 'Source change did not invalidate Hosting.'
Assert-Freshness (-not (Test-ShronchikBuildNeeded -ProjectRoot $fixtureRoot -Mode Hosting -NoBuild)) '-NoBuild did not bypass stale output.'
Save-FixtureBuild Debug
Save-FixtureBuild Hosting

Write-FixtureFile 'src/Shronchik.Web/src/new.css' 'new file'
Assert-Freshness (-not (Test-FixtureCurrent)) 'New input was missed.'
Save-FixtureBuild Debug
Remove-Item -LiteralPath (Join-Path $fixtureRoot 'src/Shronchik.Web/src/new.css')
Assert-Freshness (-not (Test-FixtureCurrent)) 'Removed input was missed.'
Save-FixtureBuild Debug
Save-FixtureBuild Hosting

Write-FixtureFile 'src/Shronchik.Server/bin/Debug/net10.0/Shronchik.Core.dll' 'corrupt'
Assert-Freshness (-not (Test-FixtureCurrent)) 'Changed Core DLL was missed.'
Assert-Freshness (Test-FixtureCurrent Hosting) 'Debug output changed Hosting state.'
Write-FixtureFile 'src/Shronchik.Server/bin/Debug/net10.0/Shronchik.Core.dll'
Assert-Freshness (Test-FixtureCurrent) 'Restored output did not match its stamp.'
Write-FixtureFile '.tools/hosting/server/wwwroot/assets/app.js' 'corrupt'
Assert-Freshness (-not (Test-FixtureCurrent Hosting)) 'Corrupted Hosting JS asset was missed.'
Assert-Freshness (Test-FixtureCurrent) 'Hosting output changed Debug state.'
Write-FixtureFile '.tools/hosting/server/wwwroot/assets/app.js' 'new tags'
Remove-Item -LiteralPath (Join-Path $fixtureRoot '.tools/hosting/server/wwwroot/assets/style.css')
Assert-Freshness (-not (Test-FixtureCurrent Hosting)) 'Missing referenced CSS asset was missed.'
Write-FixtureFile '.tools/hosting/server/wwwroot/assets/style.css' 'body{}'
Write-FixtureFile '.tools/hosting/server/tags.json' '{"version":1,"tags":["old"]}'
Assert-Freshness (-not (Test-FixtureCurrent Hosting)) 'Old published tag dictionary was trusted.'
$beforeBuild = Start-ShronchikBuildState -ProjectRoot $fixtureRoot -Mode Hosting
$failed = $false
try { Save-ShronchikBuildState -ProjectRoot $fixtureRoot -Mode Hosting -InputFingerprint $beforeBuild } catch { $failed = $true }
Assert-Freshness $failed 'Mismatched source/output tag dictionary was stamped.'
Assert-Freshness (-not (Test-Path -LiteralPath (Get-ShronchikBuildStatePath -ProjectRoot $fixtureRoot -Mode Hosting))) 'Failed dictionary check left a stamp.'
Write-FixtureFile '.tools/hosting/server/tags.json' '{"version":2,"tags":["Asia"]}'
Save-FixtureBuild Hosting
Remove-Item -LiteralPath (Join-Path $fixtureRoot '.tools/hosting/server/Shronchik.Server.dll')
Assert-Freshness (-not (Test-FixtureCurrent Hosting)) 'Missing server DLL was missed.'
Write-FixtureFile '.tools/hosting/server/Shronchik.Server.dll'

# A failed or interrupted build clears previous success before doing any work.
$unusedFingerprint = Start-ShronchikBuildState -ProjectRoot $fixtureRoot -Mode Debug
Assert-Freshness (-not (Test-FixtureCurrent)) 'Interrupted rebuild retained its previous success stamp.'
Save-FixtureBuild Debug
$beforeBuild = Start-ShronchikBuildState -ProjectRoot $fixtureRoot -Mode Debug
Write-FixtureFile 'src/Shronchik.Web/src/App.tsx' 'edited during build'
$failed = $false
try { Save-ShronchikBuildState -ProjectRoot $fixtureRoot -Mode Debug -InputFingerprint $beforeBuild } catch { $failed = $true }
Assert-Freshness $failed 'Source edit during build was stamped as current.'
Assert-Freshness (-not (Test-FixtureCurrent)) 'Failed source consistency check retained success.'
Save-FixtureBuild Debug
Write-FixtureFile '.cache/build-state/debug.json' 'invalid JSON'
Assert-Freshness (-not (Test-FixtureCurrent)) 'Malformed state was trusted.'
Save-FixtureBuild Debug
Write-FixtureFile '.cache/build-state/debug.json' '{"version":1,"mode":"Hosting"}'
Assert-Freshness (-not (Test-FixtureCurrent)) 'Wrong build mode was trusted.'
Save-FixtureBuild Debug
Remove-Item -LiteralPath (Join-Path $fixtureRoot 'src/Shronchik.Server/bin/Debug/net10.0/tags.json')
Assert-Freshness (-not (Test-FixtureCurrent)) 'Missing tag dictionary was missed.'
$beforeBuild = Start-ShronchikBuildState -ProjectRoot $fixtureRoot -Mode Debug
$failed = $false
try { Save-ShronchikBuildState -ProjectRoot $fixtureRoot -Mode Debug -InputFingerprint $beforeBuild } catch { $failed = $true }
Assert-Freshness $failed 'Incomplete output was stamped.'
Assert-Freshness (-not (Test-FixtureCurrent)) 'Incomplete output failure retained success.'
# Hash ordering is independent of culture and .NET's NLS/ICU implementation.
$orderNames = @('a.cs', 'a-b.cs', 'z.cs', ([string][char]0x00E4 + '.cs'))
$orderFiles = @($orderNames | ForEach-Object {
    $relativePath = 'hash-order/' + $_
    Write-FixtureFile $relativePath $_
    Join-Path $fixtureRoot $relativePath
})
$ordinalHash = Get-ShronchikFileFingerprint -ProjectRoot $fixtureRoot -Files $orderFiles
$previousCulture = [Threading.Thread]::CurrentThread.CurrentCulture
try {
    foreach ($culture in @('en-US', 'sv-SE', 'tr-TR')) {
        [Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo($culture)
        $cultureHash = Get-ShronchikFileFingerprint -ProjectRoot $fixtureRoot -Files @($orderFiles[3], $orderFiles[1], $orderFiles[0], $orderFiles[2], $orderFiles[0])
        Assert-Freshness ($cultureHash -eq $ordinalHash) "File ordering changed under $culture."
    }
} finally { [Threading.Thread]::CurrentThread.CurrentCulture = $previousCulture }
$pwshCommand = Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue
if ($null -ne $pwshCommand) {
    $hashScript = Join-Path $fixtureRoot 'compare-runtime.ps1'
    [IO.File]::WriteAllText($hashScript, @'
param([string]$ProjectRoot, [string]$HelperPath)
. $HelperPath
Get-ShronchikInputFingerprint -ProjectRoot $ProjectRoot
'@)
    $helperPath = Join-Path $projectRoot 'scripts/build-state.ps1'
    $ps5Hash = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $hashScript -ProjectRoot $fixtureRoot -HelperPath $helperPath
    if ($LASTEXITCODE -ne 0) { throw 'Windows PowerShell hash comparison failed.' }
    $ps7Hash = & $pwshCommand.Source -NoProfile -ExecutionPolicy Bypass -File $hashScript -ProjectRoot $fixtureRoot -HelperPath $helperPath
    if ($LASTEXITCODE -ne 0) { throw 'PowerShell 7 hash comparison failed.' }
    Assert-Freshness ($ps5Hash -match '^[0-9A-F]{64}$' -and $ps5Hash -ceq $ps7Hash) 'PowerShell 5.1 and 7 input fingerprints differ.'
}
# A second HTTPS launch must reject a busy port before touching an active build.
# Copy only the launcher into an isolated fixture; preparation throws if reached.
$guardRoot = Join-Path $fixtureRoot 'launcher-guard'
$guardScripts = Join-Path $guardRoot 'scripts'
[IO.Directory]::CreateDirectory($guardScripts) | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts/start-https.ps1') -Destination (Join-Path $guardScripts 'start-https.ps1')
[IO.File]::WriteAllText((Join-Path $guardScripts 'prepare-https.ps1'), "throw 'Preparation reached before port guard.'")
$guardListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$guardProcess = $null
try {
    $guardListener.Start()
    $guardPort = $guardListener.LocalEndpoint.Port
    $guardProcess = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $guardScripts 'start-https.ps1') + '"'),
        '-PublicIP', '203.0.113.5', '-Port', $guardPort, '-Rebuild'
    ) -RedirectStandardOutput (Join-Path $guardRoot 'stdout.log') -RedirectStandardError (Join-Path $guardRoot 'stderr.log')
    if (-not $guardProcess.WaitForExit(30000)) { throw 'Busy-port launcher check timed out.' }
    $guardError = [IO.File]::ReadAllText((Join-Path $guardRoot 'stderr.log'))
    Assert-Freshness ($guardProcess.ExitCode -ne 0 -and $guardError -match 'Busy ports:' -and
        $guardError -notmatch 'Preparation reached') 'Busy HTTPS launch reached preparation or build.'
} finally {
    $guardListener.Stop()
    if ($null -ne $guardProcess) {
        if (-not $guardProcess.HasExited) { $guardProcess.Kill() }
        $guardProcess.Dispose()
    }
}
Write-Host "Build freshness smoke: $script:checks scenarios passed."
