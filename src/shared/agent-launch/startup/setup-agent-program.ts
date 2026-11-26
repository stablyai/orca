import { quotePosixShell } from '../../shell/launch/shell-argument-quoting'
import { quotePowerShellLiteral } from '../../shell/launch/powershell-native-argument'
import { INVENTORY_WAIT_MS } from '../installation/agent-inventory-deadline'

export const SETUP_AGENT_BLOCKED_MESSAGE = 'Agent startup is blocked.'
export const SETUP_AGENT_RESOLVER_ENV = 'ORCA_SEQUENCED_AGENT_RESOLVER'
export const SETUP_AGENT_RUNTIME_ROOT_ENV = 'ORCA_SEQUENCED_AGENT_RUNTIME_ROOT'
export const SETUP_AGENT_EXECUTABLE_ENV = 'ORCA_SEQUENCED_AGENT_EXECUTABLE'

export type SetupAgentProgram = { name: string; path?: string }

export function setupAgentProgramExpression(shell: 'posix' | 'powershell'): string {
  return shell === 'posix'
    ? `"$${SETUP_AGENT_EXECUTABLE_ENV}"`
    : `$env:${SETUP_AGENT_EXECUTABLE_ENV}`
}

export function buildSetupAgentResolver(
  program: SetupAgentProgram,
  shell: 'posix' | 'powershell'
): string {
  return shell === 'posix' ? buildPosixResolver(program) : buildPowerShellResolver(program)
}

function buildPosixResolver({ name, path }: SetupAgentProgram): string {
  return [
    'orca_setup_realpath() (',
    '  path=$1; links=0',
    '  while [ "$links" -lt 40 ]; do',
    '    if [ -d "$path" ]; then CDPATH= cd -P -- "$path" && pwd -P; return "$?"; fi',
    '    dir=$(CDPATH= cd -P -- "${path%/*}/" && pwd -P) || return 1',
    '    path="${dir%/}/${path##*/}"',
    '    if [ ! -L "$path" ]; then printf "%s" "$path"; return 0; fi',
    '    link=$(command -p readlink "$path" && printf .) || return 1',
    '    link=${link%??}',
    '    case "$link" in /*) path=$link ;; *) path="$dir/$link" ;; esac',
    '    links=$((links + 1))',
    '  done',
    '  return 1',
    ')',
    'orca_setup_user_program() {',
    '  local path=$1 ancestor',
    '  case "$path" in /*) ;; *) path="$PWD/$path" ;; esac',
    '  path=$(orca_setup_realpath "$path") || return 1',
    '  if [ ! -f "$path" ] || [ ! -x "$path" ]; then return 1; fi',
    '  case "$path" in "$root"|"$root"/*) return 1 ;; esac',
    '  if [ "$root_exists" = 1 ]; then',
    '    ancestor=$path',
    '    while [ -n "$ancestor" ]; do',
    '      if [ "$ancestor" -ef "$root" ]; then return 1; fi',
    '      ancestor=${ancestor%/*}',
    '    done',
    '  fi',
    '  printf "%s" "$path"',
    '}',
    `root=$${SETUP_AGENT_RUNTIME_ROOT_ENV}`,
    'case "$root" in /*) ;; *) exit 1 ;; esac',
    'root_exists=0',
    'if [ -e "$root" ] || [ -L "$root" ]; then',
    '  root=$(orca_setup_realpath "$root") || exit 1',
    '  root_exists=1',
    'fi',
    'root=${root%/}',
    ...(path !== undefined
      ? [`orca_setup_user_program ${quotePosixShell(path)}; exit "$?"`]
      : [
          'login_shell=${SHELL:-/bin/bash}',
          'case "$login_shell" in /*) ;; *) exit 1 ;; esac',
          String.raw`captured=$("$login_shell" -lc 'printf "\nORCA_SETUP_PATH=%s." "$PATH"' </dev/null 2>/dev/null) || exit 1`,
          'case "$captured" in *$\'\\n\'ORCA_SETUP_PATH=*.) ;; *) exit 1 ;; esac',
          "PATH=${captured##*$'\\n'ORCA_SETUP_PATH=}",
          'PATH=${PATH%.}',
          `candidates=$(builtin type -ap -- ${quotePosixShell(name)}) || exit 1`,
          'while IFS= read -r candidate; do',
          '  if orca_setup_user_program "$candidate"; then exit 0; fi',
          'done <<< "$candidates"',
          'exit 1'
        ])
  ].join('\n')
}

// Why: DOS-device aliases survive GetFullPath, so compare the normalized NT paths from open handles.
const windowsFinalPathType = String.raw`using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class OrcaSetupPath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
  private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
  private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
  public static SafeFileHandle Open(string path) {
    return CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
  }
  public static string Final(SafeFileHandle handle, uint volume) {
    var path = new StringBuilder(32768);
    uint size = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, volume);
    if (size == 0 || size >= path.Capacity) throw new Win32Exception();
    return path.ToString();
  }
}`

function buildPowerShellResolver({ name, path }: SetupAgentProgram): string {
  return [
    '$resolver = [PowerShell]::Create()',
    'try {',
    '  [void]$resolver.AddScript({',
    ...powerShellProgramLookup({ name, path }),
    '  }.ToString())',
    '  $pending = $resolver.BeginInvoke()',
    `  if (!$pending.AsyncWaitHandle.WaitOne(${INVENTORY_WAIT_MS})) {`,
    `    [Console]::Error.WriteLine(${quotePowerShellLiteral(`${SETUP_AGENT_BLOCKED_MESSAGE} Try again.`)})`,
    // Exit the gate without waiting for a blocked native call to leave the runspace.
    '    [Environment]::Exit(1)',
    '  }',
    '  $resolved = $resolver.EndInvoke($pending)',
    '  if ($resolved.Count -eq 1) { [string]$resolved[0] }',
    '} catch { return } finally { $resolver.Dispose() }'
  ].join('\n')
}

function powerShellProgramLookup({ name, path }: SetupAgentProgram): string[] {
  return [
    'try {',
    '  $ErrorActionPreference = "Stop"',
    `  $root = $env:${SETUP_AGENT_RUNTIME_ROOT_ENV}`,
    '  if (!$root -or ![IO.Path]::IsPathRooted($root)) { return }',
    ...(path !== undefined
      ? [`  $candidates = @(${quotePowerShellLiteral(path)})`]
      : [
          '  $persisted = ([Environment]::GetEnvironmentVariable("Path", "Machine"), [Environment]::GetEnvironmentVariable("Path", "User")) -join ";"',
          '  $persistedEntries = $persisted -split ";" | Where-Object { $_ }',
          '  $processEntries = $env:Path -split ";" | Where-Object { $_ -and $_ -notin $persistedEntries }',
          '  $originalPath = $env:Path',
          '  try {',
          '    $env:Path = (@($processEntries) + @($persistedEntries)) -join ";"',
          `    $candidates = (Get-Command -Name ${quotePowerShellLiteral(name)} -CommandType Application -All).Path`,
          '  } finally { $env:Path = $originalPath }'
        ]),
    '  if (!$candidates) { return }',
    "  Add-Type -TypeDefinition @'",
    windowsFinalPathType,
    "'@",
    '  $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction SilentlyContinue -ErrorVariable rootError',
    '  if (!$rootItem -and $rootError[0].Exception -isnot [System.Management.Automation.ItemNotFoundException]) { return }',
    '  $rootPath = $null',
    '  if ($rootItem) {',
    '    $handle = [OrcaSetupPath]::Open($rootItem.FullName)',
    '    try {',
    '      if ($handle.IsInvalid) { return }',
    "      $rootPath = [OrcaSetupPath]::Final($handle, 2).TrimEnd('\\')",
    '    } finally { $handle.Dispose() }',
    '  }',
    '  $compare = [StringComparison]::OrdinalIgnoreCase',
    '  foreach ($candidate in $candidates) {',
    '    if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) { return }',
    '    $handle = [OrcaSetupPath]::Open([IO.Path]::GetFullPath($candidate))',
    '    try {',
    '      if ($handle.IsInvalid) { return }',
    '      if ($rootPath) {',
    '        $devicePath = [OrcaSetupPath]::Final($handle, 2)',
    "        if ($devicePath.Equals($rootPath, $compare) -or $devicePath.StartsWith($rootPath + '\\', $compare)) { continue }",
    '      }',
    '      $launchPath = [OrcaSetupPath]::Final($handle, 0)',
    "      if ($launchPath.StartsWith('\\\\?\\UNC\\', $compare)) { return '\\\\' + $launchPath.Substring(8) }",
    "      if ($launchPath.StartsWith('\\\\?\\', $compare)) { return $launchPath.Substring(4) }",
    '    } finally { $handle.Dispose() }',
    '  }',
    '} catch { return }'
  ]
}
