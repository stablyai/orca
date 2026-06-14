export function isMacPlatform(): boolean {
  return navigator.userAgent.includes('Mac')
}

export function getTerminalFileOpenHint(): string {
  return isMacPlatform()
    ? '⌘+click to open or ⇧⌘+click for default app'
    : 'Ctrl+click to open or Shift+Ctrl+click for default app'
}

export function getTerminalOrcaFileOpenHint(): string {
  return isMacPlatform() ? '⌘+click to open in Orca' : 'Ctrl+click to open in Orca'
}

// Why: local .html/.htm links keep the ordinary Orca browser route, with the
// same Shift+modifier escape hatch to the system default browser as URL links.
export function getTerminalHtmlFileOpenHint(): string {
  return isMacPlatform()
    ? '⌘+click to open or ⇧⌘+click for default browser'
    : 'Ctrl+click to open or Shift+Ctrl+click for default browser'
}

export function getTerminalUrlOpenHint(): string {
  return isMacPlatform()
    ? '⌘+click to open or ⇧⌘+click for system browser'
    : 'Ctrl+click to open or Shift+Ctrl+click for system browser'
}

export function getTerminalWorktreePathOpenHint(canOpenWithSystemDefault: boolean): string {
  if (!canOpenWithSystemDefault) {
    return isMacPlatform() ? '⌘+click to switch workspace' : 'Ctrl+click to switch workspace'
  }

  return isMacPlatform()
    ? '⌘+click to switch workspace or ⇧⌘+click to open in Finder'
    : 'Ctrl+click to switch workspace or Shift+Ctrl+click to open folder'
}
