import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'

export function isMacPlatform(): boolean {
  return navigator.userAgent.includes('Mac')
}

function terminalLinkActionHintPrefix(showActions: boolean): string {
  return showActions ? 'Click for actions, ' : ''
}

export function getTerminalFileOpenHint(showActions = true): string {
  const prefix = terminalLinkActionHintPrefix(showActions)
  return isMacPlatform()
    ? `${prefix}⌘+click to open, or ⇧⌘+click for default app`
    : `${prefix}Ctrl+click to open, or Shift+Ctrl+click for default app`
}

export function getTerminalOrcaFileOpenHint(showActions = true): string {
  const prefix = showActions ? 'Click for actions or ' : ''
  return isMacPlatform()
    ? `${prefix}⌘+click to open in Orca`
    : `${prefix}Ctrl+click to open in Orca`
}

// Why: local HTML paths keep Shift+modifier as the system-browser shortcut.
export function getTerminalHtmlFileOpenHint(showActions = true): string {
  const prefix = terminalLinkActionHintPrefix(showActions)
  return isMacPlatform()
    ? `${prefix}⌘+click to open, or ⇧⌘+click for default browser`
    : `${prefix}Ctrl+click to open, or Shift+Ctrl+click for default browser`
}

export type TerminalUrlOpenHintOptions = {
  openLinksInApp?: boolean
  modifierInverts?: boolean
  showActions?: boolean
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
  const prefix = terminalLinkActionHintPrefix(options.showActions !== false)
  if (invertsToOrca) {
    return isMacPlatform()
      ? `${prefix}⌘+click to open, or ⇧⌘+click to open in Orca`
      : `${prefix}Ctrl+click to open, or Shift+Ctrl+click to open in Orca`
  }
  return isMacPlatform()
    ? `${prefix}⌘+click to open, or ⇧⌘+click for system browser`
    : `${prefix}Ctrl+click to open, or Shift+Ctrl+click for system browser`
}

export function getTerminalUrlSystemBrowserHint(): string {
  return isMacPlatform() ? '⇧⌘+click for system browser' : 'Shift+Ctrl+click for system browser'
}

// Why: the mirror of the system-browser hint for surfaces where inverting sends the
// modifier the other way; a plain click there already opens the system browser.
export function getTerminalUrlOrcaBrowserHint(): string {
  return isMacPlatform() ? '⇧⌘+click to open in Orca' : 'Shift+Ctrl+click to open in Orca'
}

export function getTerminalWorktreePathOpenHint(
  canOpenWithSystemDefault: boolean,
  showActions = true
): string {
  const prefix = terminalLinkActionHintPrefix(showActions)
  if (!canOpenWithSystemDefault) {
    const directPrefix = showActions ? 'Click for actions or ' : ''
    return isMacPlatform()
      ? `${directPrefix}⌘+click to switch workspace`
      : `${directPrefix}Ctrl+click to switch workspace`
  }

  return isMacPlatform()
    ? `${prefix}⌘+click to switch workspace, or ⇧⌘+click to open in Finder`
    : `${prefix}Ctrl+click to switch workspace, or Shift+Ctrl+click to open folder`
}
