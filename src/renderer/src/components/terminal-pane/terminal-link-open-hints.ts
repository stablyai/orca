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

// Why: detected local .html/.htm file paths keep the same modifier gate as
// other file-path links, with Shift+modifier as the system-browser escape hatch.
export function getTerminalHtmlFileOpenHint(): string {
  return isMacPlatform()
    ? '⌘+click to open or ⇧⌘+click for default browser'
    : 'Ctrl+click to open or Shift+Ctrl+click for default browser'
}

export function getTerminalUrlOpenHint(): string {
  return isMacPlatform()
    ? 'click to open or ⇧+click for system browser'
    : 'click to open or Shift+click for system browser'
}

export function getTerminalUrlSystemBrowserHint(): string {
  return isMacPlatform() ? '⇧⌘+click for system browser' : 'Shift+Ctrl+click for system browser'
}

export function getTerminalWorktreePathOpenHint(canOpenWithSystemDefault: boolean): string {
  if (!canOpenWithSystemDefault) {
    return isMacPlatform() ? '⌘+click to switch workspace' : 'Ctrl+click to switch workspace'
  }

  return isMacPlatform()
    ? '⌘+click to switch workspace or ⇧⌘+click to open in Finder'
    : 'Ctrl+click to switch workspace or Shift+Ctrl+click to open folder'
}
