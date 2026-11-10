param(
    [string]$PublicIP,
    [ValidateRange(1024,65535)][int]$Port = 5271,
    [string]$Domain
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if ($Domain -and $PublicIP) { throw 'Supply either -Domain or -PublicIP.' }
if ($Domain) {
    $publicHost = $Domain.TrimEnd('.').ToLowerInvariant()
    if ([Uri]::CheckHostName($publicHost) -ne [UriHostNameType]::Dns -or
        $publicHost -notmatch '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') {
        throw 'Domain must be a hostname such as example.com.'
    }
} else {
    $address = $null
    if (-not [Net.IPAddress]::TryParse($PublicIP, [ref]$address) -or
        $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        throw 'PublicIP must be a public IPv4 address.'
    }
    $octets = $address.GetAddressBytes()
    if ($octets[0] -in 0,10,127 -or $octets[0] -ge 224 -or
        ($octets[0] -eq 192 -and $octets[1] -eq 168) -or
        ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
        ($octets[0] -eq 169 -and $octets[1] -eq 254) -or
        ($octets[0] -eq 100 -and $octets[1] -ge 64 -and $octets[1] -le 127)) {
        throw 'PublicIP must be a public IPv4 address.'
    }
    $publicHost = $address.ToString()
}
$caddy = Join-Path $projectRoot '.tools/caddy/2.11.9/caddy.exe'
if (-not (Test-Path -LiteralPath $caddy) -or
    (Get-FileHash -LiteralPath $caddy -Algorithm SHA256).Hash -ne '2622E239C79DF700B0EB92CBD950D1EDEE365E155A7859F358F0E55F002DF591') {
    throw 'Verified Caddy executable is missing.'
}
$hostingRoot = Join-Path $projectRoot 'data/hosting'
New-Item -ItemType Directory -Path $hostingRoot -Force | Out-Null
$configPath = Join-Path $hostingRoot 'Caddyfile'
$storagePath = (Join-Path $hostingRoot 'certificates').Replace('\', '/')
$publicOrigin = 'https://' + $publicHost
$ipTls = if ($PublicIP) {
@'
    tls {
        issuer acme https://acme-v02.api.letsencrypt.org/directory {
            profile shortlived
        }
    }
'@
}
$config = @"
{
    admin 127.0.0.1:2019
    default_sni $publicHost
    storage file_system {
        root "$storagePath"
    }
}

$publicOrigin {
$ipTls
    reverse_proxy 127.0.0.1:$Port {
        header_up Host $publicHost
    }
}
"@
[IO.File]::WriteAllText($configPath, $config, [Text.UTF8Encoding]::new($false))
& $caddy fmt --overwrite $configPath
if ($LASTEXITCODE -ne 0) { throw 'Caddy configuration formatting failed.' }
# Adapt parses configuration only. It does not run a listener or request a certificate.
& $caddy adapt --config $configPath --adapter caddyfile | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Caddy configuration parsing failed.' }
[PSCustomObject]@{ PublicOrigin = $publicOrigin; Config = $configPath; HostingRoot = $hostingRoot; Caddy = $caddy }
