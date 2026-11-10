$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$toolsPath = Join-Path $projectRoot '.tools'
New-Item -ItemType Directory -Path $toolsPath -Force | Out-Null
$installer = Join-Path $toolsPath 'dotnet-install.ps1'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installer
& $installer -Channel 10.0 -InstallDir (Join-Path $toolsPath 'dotnet') -NoPath
if ($LASTEXITCODE -ne 0) { throw '.NET SDK installation failed.' }
Write-Host 'Local .NET 10 SDK installed. Run Start-Shronchik.cmd.'
