import { quotePosixShell } from '../../shell/launch/shell-argument-quoting'
import { quotePowerShellLiteral } from '../../shell/launch/powershell-native-argument'
import type { TuiAgent } from '../catalog/tui-agent'

export const SETUP_AGENT_BLOCKED_MESSAGE = 'Agent startup is blocked.'
export const SETUP_AGENT_NOTICE_ENV = 'ORCA_SEQUENCED_AGENT_NOTICE'
export const SETUP_AGENT_RECHECK_ENV = 'ORCA_SEQUENCED_AGENT_RECHECK'
export const SETUP_AGENT_RUNTIME_ROOT_ENV = 'ORCA_SEQUENCED_AGENT_RUNTIME_ROOT'
export const SETUP_AGENT_EXECUTABLE_ENV = 'ORCA_SEQUENCED_AGENT_EXECUTABLE'
export const SETUP_AGENT_ARGV0_ENV = 'ORCA_SEQUENCED_AGENT_ARGV0'

export type SetupAgentProgram = {
  agent: TuiAgent
  launchHead: string
  path?: string
  blocked?: true
}

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

export function setupAgentProgramPathExpression(shell: 'posix' | 'powershell'): string {
  return shell === 'posix'
    ? `"$${SETUP_AGENT_EXECUTABLE_ENV}"`
    : `$env:${SETUP_AGENT_EXECUTABLE_ENV}`
}

export function setupPosixAgentExec(program: string, args = '"$@"'): string {
  return `exec -a "$${SETUP_AGENT_ARGV0_ENV}" ${program} ${args}`
}

export function setupAgentProgramExpression(shell: 'posix' | 'powershell'): string {
  const program = setupAgentProgramPathExpression(shell)
  return shell === 'posix' ? `bash -c '${setupPosixAgentExec(program)}' orca-agent` : program
}

export function buildSetupAgentRecheck(
  { path, launchHead, blocked }: SetupAgentProgram,
  shell: 'posix' | 'powershell'
): string {
  if (blocked) {
    return shell === 'posix' ? 'exit 1' : 'return'
  }
  return shell === 'posix'
    ? buildPosixRecheck(path, launchHead)
    : buildPowerShellRecheck(path, launchHead)
}

export function buildPosixSetupAgentRecheck(timeoutSeconds: number): string[] {
  return [
    'supervisor=;',
    'trap \'kill -TERM "$supervisor" 2>/dev/null; exit 129\' HUP;',
    'trap \'kill -TERM "$supervisor" 2>/dev/null; exit 130\' INT;',
    'trap \'kill -TERM "$supervisor" 2>/dev/null; exit 143\' TERM;',
    'exec 3< <(',
    '  exec 2>/dev/null;',
    '  interrupted=;',
    "  trap 'interrupted=1' HUP INT TERM;",
    // Bash 3.2 treats BASHPID as an ordinary environment variable.
    '  if [ "${BASH_VERSINFO[0]}" -ge 4 ]; then supervisor_pid=$BASHPID;',
    '  else supervisor_pid=$(BASH_ENV= exec "$BASH" -c \'printf "%s" "$PPID"\'); fi;',
    '  set -m;',
    `  (set +m; eval "$${SETUP_AGENT_RECHECK_ENV}") </dev/null & worker=$!;`,
    `  (set +m; command -p sleep ${timeoutSeconds} && {`,
    '    kill -KILL -- "-$worker" || :;',
    '    [ "$supervisor_pid" -gt 1 ] && kill -TERM "$supervisor_pid";',
    '  }) </dev/null & watchdog=$!;',
    '  cleanup() { kill -KILL -- "-$worker" "-$watchdog" || :; };',
    "  trap 'cleanup; exit 1' HUP INT TERM;",
    '  [ -z "$interrupted" ] || { cleanup; exit 1; };',
    // Complete the pipe record only after the worker exits successfully.
    '  recheck_status=0; wait "$worker" || recheck_status=$?;',
    '  cleanup;',
    '  if [ "$recheck_status" = 0 ]; then printf "\\0"; fi;',
    '); supervisor=$!;',
    `if IFS= read -r -t ${timeoutSeconds} -d "" checked <&3 && [[ "$checked" = ?*/* ]]; then`,
    `  ${SETUP_AGENT_ARGV0_ENV}=\${checked%%/*};`,
    `  ${SETUP_AGENT_EXECUTABLE_ENV}=/\${checked#*/};`,
    'else kill -TERM "$supervisor" 2>/dev/null || :; fi;',
    'exec 3<&-; trap - HUP INT TERM;'
  ]
}

function buildPosixRecheck(path: string | undefined, name: string): string {
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
    ...(path === undefined
      ? [
          `program=$(builtin type -P -- ${quotePosixShell(name)} && printf .) || exit 1`,
          'program=${program%??}',
          'case "$program" in /*) ;; *) program="${PWD%/}/$program" ;; esac'
        ]
      : [`program=${quotePosixShell(path)}`]),
    'pin=$(orca_setup_realpath "$program" && printf .) || exit 1',
    'pin=${pin%.}',
    '[ -f "$pin" ] && [ -x "$pin" ] || exit 1',
    'magic=; LC_ALL=C IFS= read -r -n 2 -d "" magic < "$pin" || :',
    // Preserve script basename and sidecar lookup, accepting that the checked spelling may be retargeted before exec.
    'if [ "$magic" = "#!" ]; then pin=$program; fi',
    'printf "%s%s" "${program##*/}" "$pin"'
  ].join('\n')
}

function buildPowerShellRecheck(path: string | undefined, name: string): string {
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
    '        if ($AllowMissing -and $links -eq 0) { return @{ Path = $path; ReparsePoint = $false } }; throw',
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
    '    if ($i -eq $parts.Length) { return @{ Path = $dir; ReparsePoint = ($links -gt 0) } }',
    '  }',
    '  throw "Too many reparse points"',
    '}',
    'try {',
    '  $compare = [StringComparison]::OrdinalIgnoreCase',
    `  $root = (Resolve-OrcaSetupPath $env:${SETUP_AGENT_RUNTIME_ROOT_ENV} $null -AllowMissing).Path.TrimEnd('\\')`,
    ...(path === undefined
      ? [
          `  $application = Get-Command -Name ${quotePowerShellLiteral(name)} -CommandType Application -ErrorAction Stop | Select-Object -First 1`,
          '  $program = $application.Path'
        ]
      : [`  $program = ${quotePowerShellLiteral(path)}`]),
    '  $resolved = Resolve-OrcaSetupPath $program $root',
    '  $pin = $resolved.Path',
    '  $extensions = ($env:PATHEXT -split ";") + @(".exe", ".com", ".cmd", ".bat", ".ps1")',
    '  $extension = [IO.Path]::GetExtension($pin)',
    '  if ($extension -in $extensions -and (Test-Path -LiteralPath $pin -PathType Leaf -ErrorAction Stop)) {',
    '    if ($resolved.ReparsePoint -and $extension -in ".exe", ".com") { return $pin }; return $program',
    '  }',
    '} catch { return }'
  ].join('\n')
}
