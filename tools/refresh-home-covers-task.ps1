$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $root

node scripts/refresh-home-covers.js
