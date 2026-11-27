# Snapshot of an Orca install folder for the update scenarios. Prints one JSON object.
param([Parameter(Mandatory = $true)][string]$InstallDir)

$exe = Join-Path $InstallDir 'Orca.exe'
$present = Test-Path -LiteralPath $exe
$uninstall = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
  ForEach-Object { Get-ItemProperty $_.PSPath } |
  Where-Object { $_.DisplayName -like 'Orca*' } | Select-Object -First 1
$prefix = (Join-Path $InstallDir '').ToLowerInvariant()
$procs = @(Get-CimInstance -ClassName Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant().StartsWith($prefix)
  } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; path = $_.ExecutablePath } })
$marker = Join-Path $InstallDir 'resources\e2e-build.txt'

[pscustomobject]@{
  present        = $present
  exeVersion     = if ($present) { (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion } else { $null }
  fileCount      = if (Test-Path -LiteralPath $InstallDir) { @(Get-ChildItem -LiteralPath $InstallDir -Recurse -File -ErrorAction SilentlyContinue).Count } else { 0 }
  displayVersion = if ($uninstall) { $uninstall.DisplayVersion } else { $null }
  marker         = if (Test-Path -LiteralPath $marker) { (Get-Content -LiteralPath $marker -Raw).Trim() } else { $null }
  processes      = $procs
} | ConvertTo-Json -Compress -Depth 4
