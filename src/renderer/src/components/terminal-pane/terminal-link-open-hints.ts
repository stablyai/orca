import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'

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

export type TerminalUrlOpenHintOptions = {
  openLinksInApp?: boolean
  modifierInverts?: boolean
}

// Why: openHttpLink only routes to Orca when the source is local, so a remote pane
// pins every link to the system browser and inverting cannot reach Orca there. The
// clicked pane's owner decides that, not the global active runtime — a workspace-bound
// remote pane is remote even when no runtime is globally active.
export function terminalUrlOpenHintOptionsFor(
  settings:
    | {
        openLinksInApp?: boolean
        openLinksInAppModifierInverts?: boolean
        activeRuntimeEnvironmentId?: string | null
      }
    | null
    | undefined,
  sourceOwner?: HttpLinkSourceOwner
): TerminalUrlOpenHintOptions {
  const sourceIsLocal = sourceOwner
    ? sourceOwner.kind === 'local'
    : !settings?.activeRuntimeEnvironmentId?.trim()
  return {
    openLinksInApp: settings?.openLinksInApp === true,
    modifierInverts: settings?.openLinksInAppModifierInverts === true && sourceIsLocal
  }
}

// Why: with modifierInverts on, Shift no longer always means "system browser" —
// it means "the other one" — so the hint has to name the actual destination.
export function getTerminalUrlOpenHint(options: TerminalUrlOpenHintOptions = {}): string {
  const invertsToOrca = options.modifierInverts === true && options.openLinksInApp !== true
  if (invertsToOrca) {
    return isMacPlatform()
      ? '⌘+click to open or ⇧⌘+click to open in Orca'
      : 'Ctrl+click to open or Shift+Ctrl+click to open in Orca'
  }
  return isMacPlatform()
    ? '⌘+click to open or ⇧⌘+click for system browser'
    : 'Ctrl+click to open or Shift+Ctrl+click for system browser'
}

export function getTerminalUrlSystemBrowserHint(): string {
  return isMacPlatform() ? '⇧⌘+click for system browser' : 'Shift+Ctrl+click for system browser'
}

// Why: the mirror of the system-browser hint for surfaces where inverting sends the
// modifier the other way; a plain click there already opens the system browser.
export function getTerminalUrlOrcaBrowserHint(): string {
  return isMacPlatform() ? '⇧⌘+click to open in Orca' : 'Shift+Ctrl+click to open in Orca'
}

export function getTerminalWorktreePathOpenHint(canOpenWithSystemDefault: boolean): string {
  if (!canOpenWithSystemDefault) {
    return isMacPlatform() ? '⌘+click to switch workspace' : 'Ctrl+click to switch workspace'
  }

  return isMacPlatform()
    ? '⌘+click to switch workspace or ⇧⌘+click to open in Finder'
    : 'Ctrl+click to switch workspace or Shift+Ctrl+click to open folder'
}
