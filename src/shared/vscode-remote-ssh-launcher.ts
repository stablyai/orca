const VSCODE_LAUNCHER_NAMES = new Set(['code', 'code-insiders', 'code - insiders'])
// Why: VS Code forks ship the same Remote-SSH argv contract
// (`--remote ssh-remote+<host> <path>`), so they can open an SSH worktree even
// though they are not VS Code. Kept separate from VSCODE_LAUNCHER_NAMES because
// that set also gates VS Code-only behavior (the Windows WSL UNC rewrite).
const REMOTE_SSH_CAPABLE_LAUNCHER_NAMES = new Set([
  ...VSCODE_LAUNCHER_NAMES,
  'cursor',
  'cursor-insiders'
])
const WINDOWS_ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\\\\)/i

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function getLauncherName(command: string): string {
  const unquoted = stripMatchingQuotes(command)
  const segments = unquoted.split(/[\\/]/)
  const fileName = segments.at(-1) ?? ''
  return fileName.replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase()
}

/** True only for VS Code itself; use for behavior VS Code forks do not share. */
export function isVsCodeLauncherExecutable(command: string): boolean {
  return VSCODE_LAUNCHER_NAMES.has(getLauncherName(command))
}

/** True for VS Code and forks that accept the same Remote-SSH argv. */
export function isRemoteSshCapableLauncherExecutable(command: string): boolean {
  return REMOTE_SSH_CAPABLE_LAUNCHER_NAMES.has(getLauncherName(command))
}

export function isVsCodeRemoteSshCommand(command: string | undefined): boolean {
  const trimmed = command?.trim() || 'code'
  const unquoted = stripMatchingQuotes(trimmed)
  if (!/\s/.test(unquoted)) {
    return isRemoteSshCapableLauncherExecutable(unquoted)
  }

  const isAbsolutePath = unquoted.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(unquoted)
  return isAbsolutePath && isRemoteSshCapableLauncherExecutable(unquoted)
}
