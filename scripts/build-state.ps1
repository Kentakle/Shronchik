# Build state is separate for local Debug and published HTTPS copies. File content,
# rather than timestamps, detects updates restored by Git or copied from elsewhere.
function Get-ShronchikTreeFiles {
    param([string]$Directory)
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return }
    foreach ($entry in Get-ChildItem -LiteralPath $Directory -Force) {
        # OneDrive cloud files also carry ReparsePoint; only skip actual links.
        if ($entry.LinkType -in @('SymbolicLink', 'Junction')) { continue }
        if ($entry.PSIsContainer) {
            if ($entry.Name -notin @('node_modules', 'bin', 'obj', 'wwwroot', '.git')) {
                Get-ShronchikTreeFiles -Directory $entry.FullName
            }
        } elseif ($entry.Name -notlike '*.tsbuildinfo') {
            $entry.FullName
        }
    }
}

function Get-ShronchikFileFingerprint {
    param([string]$ProjectRoot, [string[]]$Files)
    $rootPrefix = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    # Sort-Object uses NLS in Windows PowerShell and ICU in PowerShell 7;
    # punctuation order differs even with the same culture. Use ordinal paths.
    $orderedFiles = [Collections.Generic.SortedSet[string]]::new([StringComparer]::Ordinal)
    foreach ($file in $Files) { [void]$orderedFiles.Add([IO.Path]::GetFullPath($file)) }
    $lines = foreach ($fullPath in $orderedFiles) {
        if (-not $fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Build input is outside the project.' }
        $relative = $fullPath.Substring($rootPrefix.Length).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash
        $relative + ':' + $hash
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))))).Replace('-', '') }
    finally { $sha.Dispose() }
}

function Get-ShronchikInputFingerprint {
    param([string]$ProjectRoot)
    $files = @(
        foreach ($directory in @('src/Shronchik.Core', 'src/Shronchik.Server', 'src/Shronchik.Web', 'shared')) {
            Get-ShronchikTreeFiles -Directory (Join-Path $ProjectRoot $directory)
        }
        foreach ($pattern in @('global.json', 'NuGet.Config', 'Shronchik.slnx', 'Directory.Build.*', 'Directory.Packages.*')) {
            Get-ChildItem -LiteralPath $ProjectRoot -Filter $pattern -File | ForEach-Object FullName
        }
        foreach ($script in @('build-state.ps1', 'build-hosting.ps1', 'start.ps1', 'start-https.ps1')) {
            $path = Join-Path $ProjectRoot ('scripts/' + $script)
            if (Test-Path -LiteralPath $path -PathType Leaf) { $path }
        }
    )
    Get-ShronchikFileFingerprint -ProjectRoot $ProjectRoot -Files $files
}

function Get-ShronchikOutputFingerprint {
    param([string]$ProjectRoot, [ValidateSet('Debug', 'Hosting')][string]$Mode)
    $serverRoot = Join-Path $ProjectRoot 'src/Shronchik.Server'
    $binaryRoot = Join-Path $serverRoot 'bin/Debug/net10.0'
    if ($Mode -eq 'Hosting') {
        $serverRoot = Join-Path $ProjectRoot '.tools/hosting/server'
        $binaryRoot = $serverRoot
    }
    $webRoot = Join-Path $serverRoot 'wwwroot'
    $required = @('Shronchik.Server.dll', 'Shronchik.Core.dll', 'Shronchik.Server.deps.json', 'Shronchik.Server.runtimeconfig.json', 'tags.json')
    $files = @(
        foreach ($name in $required) {
            $path = Join-Path $binaryRoot $name
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Build output is missing: $path" }
            $path
        }
        $index = Join-Path $webRoot 'index.html'
        if (-not (Test-Path -LiteralPath $index -PathType Leaf)) { throw "Build output is missing: $index" }
        # wwwroot is excluded while scanning sources, but included as an output root.
        Get-ShronchikTreeFiles -Directory $webRoot
    )
    $assetReferences = [regex]::Matches([IO.File]::ReadAllText($index), '(?:src|href)=["''](/assets/[^"''?#]+)')
    if ($assetReferences.Count -eq 0) { throw 'Built frontend has no asset references.' }
    foreach ($reference in $assetReferences) {
        $path = Join-Path $webRoot $reference.Groups[1].Value.TrimStart('/')
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Frontend asset is missing: $path" }
    }
    $sourceTags = (Get-FileHash -LiteralPath (Join-Path $ProjectRoot 'shared/tags.json') -Algorithm SHA256).Hash
    $outputTags = (Get-FileHash -LiteralPath (Join-Path $binaryRoot 'tags.json') -Algorithm SHA256).Hash
    if ($sourceTags -ne $outputTags) { throw 'Built tag dictionary differs from shared/tags.json.' }
    Get-ShronchikFileFingerprint -ProjectRoot $ProjectRoot -Files $files
}

function Get-ShronchikBuildStatePath {
    param([string]$ProjectRoot, [ValidateSet('Debug', 'Hosting')][string]$Mode)
    Join-Path $ProjectRoot ('.cache/build-state/' + $Mode.ToLowerInvariant() + '.json')
}

function Test-ShronchikBuildCurrent {
    param([string]$ProjectRoot, [ValidateSet('Debug', 'Hosting')][string]$Mode)
    try {
        $path = Get-ShronchikBuildStatePath -ProjectRoot $ProjectRoot -Mode $Mode
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
        $state = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        if ($state.version -ne 1 -or $state.mode -ne $Mode) { return $false }
        return ($state.inputs -eq (Get-ShronchikInputFingerprint -ProjectRoot $ProjectRoot) -and
            $state.outputs -eq (Get-ShronchikOutputFingerprint -ProjectRoot $ProjectRoot -Mode $Mode))
    } catch { return $false }
}

function Test-ShronchikBuildNeeded {
    param([string]$ProjectRoot, [ValidateSet('Debug', 'Hosting')][string]$Mode, [switch]$NoBuild, [switch]$Rebuild)
    if ($Rebuild) { return $true }
    if ($NoBuild) { return $false }
    return -not (Test-ShronchikBuildCurrent -ProjectRoot $ProjectRoot -Mode $Mode)
}

function Build-ShronchikWeb {
    param([string]$ProjectRoot)
    Push-Location (Join-Path $ProjectRoot 'src/Shronchik.Web')
    try {
        $lockHash = (Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256).Hash
        $dependencyStamp = 'node_modules/.shronchik-lock-hash'
        if (-not (Test-Path -LiteralPath $dependencyStamp -PathType Leaf) -or
            (Get-Content -LiteralPath $dependencyStamp -Raw) -ne $lockHash) {
            & npm.cmd ci --no-fund --no-audit
            if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
            Set-Content -LiteralPath $dependencyStamp -Value $lockHash -NoNewline -Encoding ascii
        }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    }
    finally { Pop-Location }
}

function Start-ShronchikBuildState {
    param([string]$ProjectRoot, [ValidateSet('Debug', 'Hosting')][string]$Mode)
    $path = Get-ShronchikBuildStatePath -ProjectRoot $ProjectRoot -Mode $Mode
    # A failed or interrupted rebuild must never leave a successful build stamp.
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    Get-ShronchikInputFingerprint -ProjectRoot $ProjectRoot
}

function Save-ShronchikBuildState {
    param([string]$ProjectRoot, [ValidateSet('Debug', 'Hosting')][string]$Mode, [string]$InputFingerprint)
    if ($InputFingerprint -ne (Get-ShronchikInputFingerprint -ProjectRoot $ProjectRoot)) {
        throw 'Sources changed during the build. Run the launcher again.'
    }
    $state = [ordered]@{
        version = 1
        mode = $Mode
        inputs = $InputFingerprint
        outputs = Get-ShronchikOutputFingerprint -ProjectRoot $ProjectRoot -Mode $Mode
    }
    $path = Get-ShronchikBuildStatePath -ProjectRoot $ProjectRoot -Mode $Mode
    [IO.Directory]::CreateDirectory((Split-Path $path -Parent)) | Out-Null
    $temporary = $path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}
