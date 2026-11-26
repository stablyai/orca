# Holds -Path open for reading without delete sharing (as an antivirus scanner or indexer can), so
# nothing can move or delete it. Writes "holding" to -ReadyFile once the handle is open.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$ReadyFile
)
try {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
} catch {
  Set-Content -LiteralPath "$ReadyFile.err" -Value $_.Exception.ToString()
  exit 1
}
Set-Content -LiteralPath $ReadyFile -Value 'holding'
Start-Sleep -Seconds 3600
$stream.Dispose()
