# Emits the main-module path and every loaded module (DLL) path for a process,
# as a single JSON document, for the daemon-relocation spike's handle probe.
#
# Loaded DLLs are the update-time lock risk: the NSIS installer's CHECK_APP_RUNNING
# sweep force-closes processes whose image is under $INSTDIR, and files a live
# process maps cannot be replaced. A relocated host must load ZERO modules from
# the app dir. Data files (icudtl.dat, asar) are not memory-mapped as modules, so
# this probe covers the lock-critical set, not the entire open-handle set.
#
# PS 5.1 guard: $proc.Modules can be a single object (no .Count); @(...) forces
# an array so the enumeration and count are correct for one-module processes.

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
