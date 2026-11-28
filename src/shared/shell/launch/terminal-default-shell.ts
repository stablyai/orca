/** Stored form of the Terminal shell setting; launches read it raw, so it must never carry padding. '' = system shell. */
export function normalizeTerminalDefaultShell(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function isWindowsCustomShellPath(path: string): boolean {
  return (
    /^[a-z]:[\\/][^<>:"|?*]+\.exe$/i.test(path) &&
    !/[\\/]wsl\.exe$/i.test(path) &&
    Array.from(path).every((character) => character >= ' ')
  )
}
export type TerminalCustomShellSettings = {
  /** Use terminalDefaultShell for new interactive Windows terminals. */
  terminalWindowsUseCustomShell?: boolean
  /** Optional shell executable for new local terminals. */
  terminalDefaultShell?: string
  /** Optional argv for the configured shell in ordinary interactive panes. */
  terminalDefaultShellArgs?: string[]
}
