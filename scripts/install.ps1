# Installs tgmcp __VERSION__ from its GitHub release (Windows x64):
#   powershell -ExecutionPolicy Bypass -c "irm https://github.com/__REPO__/releases/download/v__VERSION__/tgmcp-installer.ps1 | iex"
#
# tgmcp.exe and the tray app (TelegramMCPTray.exe) go to %LOCALAPPDATA%\Programs\tgmcp
# (TGMCP_INSTALL_DIR to change it), which is added to your user PATH. The download is checked
# against its published SHA-256.
# TGMCP_DOWNLOAD_URL fetches the files from somewhere else (the release workflow tests with it).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Version = '__VERSION__'
$Repo = '__REPO__'
$Name = 'tgmcp-x86_64-pc-windows-msvc'
$Base = if ($env:TGMCP_DOWNLOAD_URL) { $env:TGMCP_DOWNLOAD_URL } else { "https://github.com/$Repo/releases/download/v$Version" }
$InstallDir = if ($env:TGMCP_INSTALL_DIR) { $env:TGMCP_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\tgmcp' }

if (-not [Environment]::Is64BitOperatingSystem) { throw 'tgmcp needs 64-bit Windows.' }
# Windows PowerShell 5.1 does not offer TLS 1.2 by default.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("tgmcp-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  Write-Host "Downloading tgmcp $Version (x86_64-pc-windows-msvc)"
  $Zip = Join-Path $Tmp "$Name.zip"
  $Sum = Join-Path $Tmp "$Name.zip.sha256"
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Name.zip" -OutFile $Zip
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Name.zip.sha256" -OutFile $Sum
  $Expected = ((Get-Content -Raw $Sum).Trim() -split '\s+')[0]
  $Actual = (Get-FileHash -Algorithm SHA256 $Zip).Hash
  if ($Actual -ne $Expected) { throw "Checksum mismatch for $Name.zip (expected $Expected, got $Actual)." }
  Expand-Archive -Path $Zip -DestinationPath $Tmp -Force

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  # A running exe can't be overwritten, but it can be renamed out of the way.
  function Install-Exe([string]$File) {
    $Dest = Join-Path $InstallDir $File
    if (Test-Path $Dest) {
      Remove-Item -Force -ErrorAction SilentlyContinue "$Dest.old"
      Move-Item -Force $Dest "$Dest.old"
    }
    Copy-Item (Join-Path $Tmp "$Name\$File") $Dest
    Remove-Item -Force -ErrorAction SilentlyContinue "$Dest.old"
    Write-Host "Installed $Dest"
  }
  Install-Exe 'tgmcp.exe'
  $Tray = Join-Path $InstallDir 'TelegramMCPTray.exe'
  $TrayRunning = $false
  if (Test-Path (Join-Path $Tmp "$Name\TelegramMCPTray.exe")) {
    # Ask a running tray app to quit (it waits up to 5 s), and start the new one afterwards.
    if (Test-Path $Tray) {
      $TrayRunning = @(Get-Process -Name 'TelegramMCPTray' -ErrorAction SilentlyContinue).Count -gt 0
      if ($TrayRunning) { Start-Process $Tray -ArgumentList '--quit' -Wait -WindowStyle Hidden }
    }
    Install-Exe 'TelegramMCPTray.exe'
    if ($TrayRunning) { Start-Process $Tray }
  }

  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $Parts = @($UserPath -split ';' | Where-Object { $_ -ne '' })
  if ($Parts -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable('Path', (@($Parts) + $InstallDir) -join ';', 'User')
    Write-Host "Added $InstallDir to your PATH (open a new terminal to use it)."
  }
  Write-Host ''
  Write-Host 'First time: `tgmcp login`, then run `tgmcp daemon` and keep it running.'
  Write-Host '`tgmcp menubar` starts the tray app (and at every login), and'
  Write-Host '`tgmcp mcp-add` prints the command that adds it to Claude Code.'
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Tmp
}
