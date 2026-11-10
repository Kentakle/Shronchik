[CmdletBinding(SupportsShouldProcess)]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$program = Join-Path $projectRoot '.tools/caddy/2.11.9/caddy.exe'
if (-not (Test-Path -LiteralPath $program)) { throw 'Caddy executable is missing.' }
$name = 'Shronchik-Caddy-HTTPS'
$rule = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
if ($rule) {
    $application = $rule | Get-NetFirewallApplicationFilter
    if ($application.Program -ne $program) { throw 'Existing firewall rule points to a different program.' }
    Write-Output 'Shronchik Caddy firewall rule already exists.'
    return
}
if ($PSCmdlet.ShouldProcess('Caddy TCP 80,443', 'Allow inbound HTTP certificate validation and HTTPS')) {
    New-NetFirewallRule -Name $name -DisplayName 'Shronchik HTTPS (Caddy)' -Direction Inbound -Action Allow -Enabled True -Program $program -Protocol TCP -LocalPort 80,443 -Profile Private,Public | Out-Null
    Write-Output 'Created the Caddy-only inbound rule for TCP 80 and 443.'
}
