import { quotePosixShell } from '../../shell/launch/shell-argument-quoting'
import { quotePowerShellLiteral } from '../../shell/launch/powershell-native-argument'

export const SETUP_AGENT_RESOLVER_ENV = 'ORCA_SEQUENCED_AGENT_RESOLVER'
export const SETUP_AGENT_RUNTIME_ROOT_ENV = 'ORCA_SEQUENCED_AGENT_RUNTIME_ROOT'
export const SETUP_AGENT_EXECUTABLE_ENV = 'ORCA_SEQUENCED_AGENT_EXECUTABLE'

export function setupAgentProgramExpression(shell: 'posix' | 'powershell'): string {
  return shell === 'posix'
    ? `"$${SETUP_AGENT_EXECUTABLE_ENV}"`
    : `$env:${SETUP_AGENT_EXECUTABLE_ENV}`
}

export function buildSetupAgentResolver(program: string, shell: 'posix' | 'powershell'): string {
  return shell === 'posix' ? buildPosixResolver(program) : buildPowerShellResolver(program)
}

function buildPosixResolver(program: string): string {
  return [
    'orca_setup_realpath() (',
    '  path=$1; links=0',
    '  while [ "$links" -lt 40 ]; do',
    '    if [ -d "$path" ]; then CDPATH= cd -P -- "$path" && pwd -P; return "$?"; fi',
    '    dir=$(CDPATH= cd -P -- "${path%/*}/" && pwd -P) || return 1',
    '    path="${dir%/}/${path##*/}"',
    '    if [ ! -L "$path" ]; then printf "%s" "$path"; return 0; fi',
    '    link=$(readlink "$path" && printf .) || return 1',
    '    link=${link%??}',
    '    case "$link" in /*) path=$link ;; *) path="$dir/$link" ;; esac',
    '    links=$((links + 1))',
    '  done',
    '  return 1',
    ')',
    `path=$(command -v ${quotePosixShell(program)}) || exit 1`,
    'case "$path" in "alias "*) exit 1 ;; /*) ;; */*) path="$PWD/$path" ;; *) exit 1 ;; esac',
    'path=$(orca_setup_realpath "$path") || exit 1',
    'if [ ! -f "$path" ] || [ ! -x "$path" ]; then exit 1; fi',
    `root=$${SETUP_AGENT_RUNTIME_ROOT_ENV}`,
    'case "$root" in /*) ;; *) exit 1 ;; esac',
    'if [ -e "$root" ] || [ -L "$root" ]; then root=$(orca_setup_realpath "$root") || exit 1; fi',
    'if [ "$OSTYPE" = msys ]; then shopt -s nocasematch; fi',
    'root=${root%/}',
    'case "$path" in "$root"|"$root"/*) exit 1 ;; esac',
    'printf "%s" "$path"'
  ].join('\n')
}

function buildPowerShellResolver(program: string): string {
  return [
    'function Resolve-OrcaSetupPath([string]$path) {',
    '  for ($links = 0; $links -lt 40; $links++) {',
    '    $path = [IO.Path]::GetFullPath($path)',
    '    $prefix = [IO.Path]::GetPathRoot($path)',
    "    $parts = $path.Substring($prefix.Length).Split([char[]]'\\', [StringSplitOptions]::RemoveEmptyEntries)",
    '    $redirected = $false',
    '    for ($i = 0; $i -lt $parts.Length; $i++) {',
    '      $prefix = [IO.Path]::Combine($prefix, $parts[$i])',
    '      $item = Get-Item -LiteralPath $prefix -Force -ErrorAction Stop',
    '      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {',
    '        $target = if ($item.LinkTarget) { $item.LinkTarget } else { $item.Target }',
    '        $target = @($target)[0]',
    '        if (!$target) { return }',
    "        if ($target.StartsWith('\\??\\') -or $target.StartsWith('\\\\?\\')) {",
    '          $target = $target.Substring(4)',
    "          if ($target.StartsWith('UNC\\')) { $target = '\\\\' + $target.Substring(4) }",
    '        }',
    '        $path = [IO.Path]::Combine([IO.Path]::GetDirectoryName($prefix), $target)',
    '        for ($j = $i + 1; $j -lt $parts.Length; $j++) { $path = [IO.Path]::Combine($path, $parts[$j]) }',
    '        $redirected = $true',
    '        break',
    '      }',
    '    }',
    '    if (!$redirected) { return $prefix }',
    '  }',
    '}',
    'try {',
    `  $app = Get-Command -Name ${quotePowerShellLiteral(program)} -CommandType Application -TotalCount 1 -ErrorAction Stop`,
    `  $root = $env:${SETUP_AGENT_RUNTIME_ROOT_ENV}`,
    '  if (!$app.Path -or !$root) { return }',
    '  $path = Resolve-OrcaSetupPath $app.Path',
    '  if (!$path -or !(Test-Path -LiteralPath $path -PathType Leaf)) { return }',
    '  if (Test-Path -LiteralPath $root -ErrorAction Stop) { $root = Resolve-OrcaSetupPath $root }',
    '  if (!$root) { return }',
    "  $root = $root.TrimEnd('\\')",
    '  $compare = [StringComparison]::OrdinalIgnoreCase',
    "  if (!$path.Equals($root, $compare) -and !$path.StartsWith($root + '\\', $compare)) { $path }",
    '} catch { return }'
  ].join('\n')
}
