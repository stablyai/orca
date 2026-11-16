import { quotePosixShellUnlessPlainNoAt } from '../../shell/launch/shell-argument-quoting'

export function setupMarkerPath(runnerPath: string, nonce: string): string {
  const slash = Math.max(runnerPath.lastIndexOf('/'), runnerPath.lastIndexOf('\\'))
  const directory = slash === -1 ? '.' : runnerPath.slice(0, slash)
  return `${directory}/setup-completions/${nonce}.done`
}

// Readers expire within two hours; a full day also covers overlapping retries and clock skew.
export function preparePosixSetupMarkers(markerPath: string): string {
  const directory = quotePosixShellUnlessPlainNoAt(markerPath.slice(0, markerPath.lastIndexOf('/')))
  return `mkdir -p ${directory}; find ${directory} -maxdepth 1 -type f \\( -name '*.done' -o -name '*.done*.tmp' -o -name '*.done.claim' \\) -mmin +1440 -delete 2>/dev/null`
}

export const PREPARE_WINDOWS_SETUP_MARKERS =
  '$markerDir = [IO.Path]::GetDirectoryName($marker); [IO.Directory]::CreateDirectory($markerDir) | Out-Null; ' +
  'Get-ChildItem -LiteralPath $markerDir -File -ErrorAction SilentlyContinue | ' +
  'Where-Object { ($_.Name.EndsWith(".done") -or $_.Name -like "*.done*.tmp" -or $_.Name.EndsWith(".done.claim")) -and $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-1) } | ' +
  'Remove-Item -Force -ErrorAction SilentlyContinue'
