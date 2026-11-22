const VSCODE_LAUNCHER_NAMES = new Set(['code', 'code-insiders', 'code - insiders'])
const WINDOWS_ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\\\\)/i

/** `vscode-remote` editors take `--remote ssh-remote+<authority>`; Zed takes an `ssh://` URL. */
export type RemoteSshEditorKind = 'vscode-remote' | 'zed'

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function getLauncherName(command: string): string {
  const segments = stripMatchingQuotes(command).split(/[\\/]/)
  const fileName = segments.at(-1) ?? ''
  return fileName.replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase()
}

export function isVsCodeLauncherExecutable(command: string): boolean {
  return VSCODE_LAUNCHER_NAMES.has(getLauncherName(command))
}

export function getRemoteSshEditorKind(executable: string): RemoteSshEditorKind | null {
  const name = getLauncherName(executable)
  if (VSCODE_LAUNCHER_NAMES.has(name) || name === 'cursor') {
    return 'vscode-remote'
  }
  // Arch and Fedora package the Zed CLI as zeditor.
  return name === 'zed' || name === 'zeditor' ? 'zed' : null
}

export function isRemoteSshEditorCommand(command: string | undefined): boolean {
  const trimmed = command?.trim() || 'code'
  const unquoted = stripMatchingQuotes(trimmed)
  if (!/\s/.test(unquoted)) {
    return getRemoteSshEditorKind(unquoted) !== null
  }

  const isAbsolutePath = unquoted.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(unquoted)
  return isAbsolutePath && getRemoteSshEditorKind(unquoted) !== null
}
