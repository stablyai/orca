import { quotePosixShell } from '../../shell/launch/shell-argument-quoting'
import { quotePowerShellLiteral } from '../../shell/launch/powershell-native-argument'
import type { TuiAgent } from '../catalog/tui-agent'

export const SETUP_AGENT_BLOCKED_MESSAGE = 'Agent startup is blocked.'
export const SETUP_AGENT_NOTICE_ENV = 'ORCA_SEQUENCED_AGENT_NOTICE'
export const SETUP_AGENT_RECHECK_ENV = 'ORCA_SEQUENCED_AGENT_RECHECK'
export const SETUP_AGENT_RUNTIME_ROOT_ENV = 'ORCA_SEQUENCED_AGENT_RUNTIME_ROOT'
export const SETUP_AGENT_EXECUTABLE_ENV = 'ORCA_SEQUENCED_AGENT_EXECUTABLE'

export type SetupAgentProgram = { agent: TuiAgent; launchHead: string; path?: string }

export function setupAgentBlockedNotice(
  agent: string,
  translate: (key: string, fallback: string, values: { agent: string }) => string = (
    _key,
    fallback,
    values
  ) => fallback.replace('{{agent}}', values.agent)
): string {
  return translate(
    'terminal.agentStartup.setupBlocked',
    "Setup finished. Orca couldn't verify {{agent}} for this launch. Start it from the agent menu.",
    { agent }
  )
}

export function setupAgentProgramExpression(shell: 'posix' | 'powershell'): string {
  return shell === 'posix'
    ? `"$${SETUP_AGENT_EXECUTABLE_ENV}"`
    : `$env:${SETUP_AGENT_EXECUTABLE_ENV}`
}

export function buildSetupAgentRecheck(
  path: string | undefined,
  shell: 'posix' | 'powershell'
): string {
  if (path === undefined) {
    return shell === 'posix' ? 'exit 1' : 'return'
  }
  return shell === 'posix' ? buildPosixRecheck(path) : buildPowerShellRecheck(path)
}

function buildPosixRecheck(path: string): string {
  return [
    'orca_setup_realpath() (',
    '  rest=${1#/}; dir=; links=0',
    '  while [ -n "$rest" ]; do',
    '    part=${rest%%/*}',
    '    case "$rest" in */*) rest=${rest#*/} ;; *) rest= ;; esac',
    '    case "$part" in ""|.) continue ;; ..) dir=${dir%/*}; continue ;; esac',
    '    item="$dir/$part"',
    '    if [ -n "$root" ]; then',
    '      case "$item" in "$root"|"$root"/*) return 1 ;; esac',
    '      if [ "$item" -ef "$root" ]; then return 1; fi',
    '    fi',
    '    if [ -L "$item" ]; then',
    '      [ "$links" -lt 40 ] || return 1',
    '      link=$(command -p readlink "$item" && printf .) || return 1',
    '      link=${link%??}',
    '      case "$link" in /*) dir=; link=${link#/} ;; esac',
    '      rest="$link/$rest"; links=$((links + 1))',
    '    else',
    '      if [ -n "$rest" ] && [ ! -d "$item" ]; then return 1; fi',
    '      dir=$item',
    '    fi',
    '  done',
    '  printf "%s" "${dir:-/}"',
    ')',
    `runtime=$${SETUP_AGENT_RUNTIME_ROOT_ENV}`,
    'case "$runtime" in /*) ;; *) exit 1 ;; esac',
    'root=',
    'if [ -e "$runtime" ] || [ -L "$runtime" ]; then',
    '  root=$(CDPATH= cd -P -- "$runtime" && pwd -P && printf .) || exit 1',
    '  root=${root%??}',
    'fi',
    'root=${root:-$runtime}; root=${root%/}',
    `pin=$(orca_setup_realpath ${quotePosixShell(path)} && printf .) || exit 1`,
    'pin=${pin%.}',
    '[ -f "$pin" ] && [ -x "$pin" ] && printf "%s." "$pin"'
  ].join('\n')
}

function buildPowerShellRecheck(path: string): string {
  return [
    'function Resolve-OrcaSetupPath($path, $root, [switch]$AllowMissing) {',
    '  for ($links = 0; $links -le 40; $links++) {',
    String.raw`    if ($path -notmatch '^(?:[A-Z]:\\|\\\\[^\\?.][^\\]*\\[^\\]+\\)') { throw 'Invalid absolute path' }`,
    '    $path = [IO.Path]::GetFullPath($path)',
    '    $dir = [IO.Path]::GetPathRoot($path)',
    "    $parts = $path.Substring($dir.Length).Split('\\', [StringSplitOptions]::RemoveEmptyEntries)",
    '    for ($i = 0; $i -lt $parts.Length; $i++) {',
    '      $itemPath = [IO.Path]::Combine($dir, $parts[$i])',
    "      if ($root -and ($itemPath.Equals($root, $compare) -or $itemPath.StartsWith($root + '\\', $compare))) { throw 'Orca runtime path' }",
    '      try { $item = Get-Item -LiteralPath $itemPath -Force -ErrorAction Stop }',
    '      catch [System.Management.Automation.ItemNotFoundException] {',
    '        if ($AllowMissing -and $links -eq 0) { return $path }; throw',
    '      }',
    '      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {',
    '        if ($item.LinkType -notin "SymbolicLink", "Junction" -or @($item.Target).Count -ne 1 -or !$item.Target) { throw "Unresolved reparse point" }',
    '        $target = [string]@($item.Target)[0]',
    String.raw`        if ($target -match '^\\\\\?\\UNC\\') { $target = '\\' + $target.Substring(8) }`,
    String.raw`        elseif ($target -match '^\\\\\?\\[A-Z]:\\') { $target = $target.Substring(4) }`,
    '        if (![IO.Path]::IsPathRooted($target)) { $target = [IO.Path]::Combine($dir, $target) }',
    '        $path = $target',
    '        for ($j = $i + 1; $j -lt $parts.Length; $j++) { $path = [IO.Path]::Combine($path, $parts[$j]) }',
    '        break',
    '      }',
    '      $dir = $item.FullName',
    '    }',
    '    if ($i -eq $parts.Length) { return $dir }',
    '  }',
    '  throw "Too many reparse points"',
    '}',
    'try {',
    '  $compare = [StringComparison]::OrdinalIgnoreCase',
    `  $root = (Resolve-OrcaSetupPath $env:${SETUP_AGENT_RUNTIME_ROOT_ENV} $null -AllowMissing).TrimEnd('\\')`,
    `  $pin = Resolve-OrcaSetupPath ${quotePowerShellLiteral(path)} $root`,
    '  $extensions = ($env:PATHEXT -split ";") + @(".exe", ".com", ".cmd", ".bat", ".ps1")',
    '  if ([IO.Path]::GetExtension($pin) -in $extensions -and (Test-Path -LiteralPath $pin -PathType Leaf -ErrorAction Stop)) { return $pin }',
    '} catch { return }'
  ].join('\n')
}
