# Report process image/loaded DLLs as JSON for relocation’s lock-critical set, not all open handles (e.g. asar/icudtl.dat).
# NSIS kills $INSTDIR processes and mapped files cannot be replaced; relocated hosts must load no app-directory modules.
# PS 5.1: wrap Modules in @() so a single object still has array enumeration/count semantics.

param(
  [Parameter(Mandatory = $true)]
  [int]$ProcessId
)

$ErrorActionPreference = 'Stop'

try {
  $proc = Get-Process -Id $ProcessId -ErrorAction Stop
} catch {
  Write-Output (@{ found = $false; mainModule = $null; modules = @() } | ConvertTo-Json -Compress)
  exit 0
}

$modulePaths = @()
foreach ($m in @($proc.Modules)) {
  if ($m -and $m.FileName) {
    $modulePaths += $m.FileName
  }
}

$mainModule = $null
if ($proc.MainModule -and $proc.MainModule.FileName) {
  $mainModule = $proc.MainModule.FileName
}

$result = @{
  found      = $true
  mainModule = $mainModule
  modules    = $modulePaths
}
Write-Output ($result | ConvertTo-Json -Compress -Depth 4)
