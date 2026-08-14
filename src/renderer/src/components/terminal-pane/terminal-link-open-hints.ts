import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import type { TerminalHttpLinkActionDestinations } from './terminal-url-link-hit-testing'

export function isMacPlatform(): boolean {
  return navigator.userAgent.includes('Mac')
}

function terminalLinkActionHintPrefix(showActions: boolean): string {
  return showActions ? 'Click for actions, ' : ''
}

// Why: every inverted hint has the same shape — the bare modifier reaches the OS
// destination and Shift reaches Orca — so one template covers all three link kinds.
function invertedChordHint(prefix: string, bareTarget: string, shiftTarget: string): string {
  return isMacPlatform()
    ? `${prefix}⌘+click ${bareTarget}, or ⇧⌘+click ${shiftTarget}`
    : `${prefix}Ctrl+click ${bareTarget}, or Shift+Ctrl+click ${shiftTarget}`
}

export function getTerminalFileOpenHint(showActions = true, modifierInverts = false): string {
  const prefix = terminalLinkActionHintPrefix(showActions)
  if (modifierInverts) {
    return invertedChordHint(prefix, 'for default app', 'to open in Orca')
  }
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
export function getTerminalHtmlFileOpenHint(showActions = true, modifierInverts = false): string {
  const prefix = terminalLinkActionHintPrefix(showActions)
  if (modifierInverts) {
    return invertedChordHint(prefix, 'for default browser', 'to open in Orca')
  }
  return isMacPlatform()
    ? `${prefix}⌘+click to open, or ⇧⌘+click for default browser`
    : `${prefix}Ctrl+click to open, or Shift+Ctrl+click for default browser`
}

export type TerminalFileLinkHoverHintOptions = {
  canOpenWithSystemDefault: boolean
  isWorktreeRoot: boolean
  isHtmlFile: boolean
  showActions: boolean
  modifierInverts: boolean
}

export function getTerminalFileLinkHoverHint({
  canOpenWithSystemDefault,
  isWorktreeRoot,
  isHtmlFile,
  showActions,
  modifierInverts
}: TerminalFileLinkHoverHintOptions): string {
  if (isWorktreeRoot) {
    return getTerminalWorktreePathOpenHint(canOpenWithSystemDefault, showActions, modifierInverts)
  }
  if (!canOpenWithSystemDefault) {
    return getTerminalOrcaFileOpenHint(showActions)
  }
  return isHtmlFile
    ? getTerminalHtmlFileOpenHint(showActions, modifierInverts)
    : getTerminalFileOpenHint(showActions, modifierInverts)
}

export type TerminalUrlOpenHintOptions = {
  openLinksInApp?: boolean
  modifierInverts?: boolean
  showActions?: boolean
}

export function terminalHttpLinkActionDestinationsFor(
  settings: { openLinksInApp?: boolean } | null | undefined,
  sourceOwner: HttpLinkSourceOwner,
  canOpenRuntimeBrowser: boolean
): TerminalHttpLinkActionDestinations {
  const canOpenInOrca =
    sourceOwner.kind === 'local' || (sourceOwner.kind === 'runtime' && canOpenRuntimeBrowser)
  if (!canOpenInOrca) {
    return { primary: 'system' }
  }
  return settings?.openLinksInApp === true
    ? { primary: 'orca', alternate: 'system' }
    : { primary: 'system', alternate: 'orca' }
}

// Why: only a capability-verified runtime can advertise the in-app destination.
export function terminalUrlOpenHintOptionsFor(
  settings:
    | {
        openLinksInApp?: boolean
        openLinksInAppModifierInverts?: boolean
        activeRuntimeEnvironmentId?: string | null
      }
    | null
    | undefined,
  sourceOwner?: HttpLinkSourceOwner,
  canOpenRuntimeBrowser = false
): TerminalUrlOpenHintOptions {
  const sourceCanOpenInOrca = sourceOwner
    ? sourceOwner.kind === 'local' || (sourceOwner.kind === 'runtime' && canOpenRuntimeBrowser)
    : !settings?.activeRuntimeEnvironmentId?.trim()
  return {
    openLinksInApp: settings?.openLinksInApp === true,
    modifierInverts: settings?.openLinksInAppModifierInverts === true && sourceCanOpenInOrca
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
  showActions = true,
  modifierInverts = false
): string {
  const prefix = terminalLinkActionHintPrefix(showActions)
  if (!canOpenWithSystemDefault) {
    const directPrefix = showActions ? 'Click for actions or ' : ''
    return isMacPlatform()
      ? `${directPrefix}⌘+click to switch workspace`
      : `${directPrefix}Ctrl+click to switch workspace`
  }

  if (modifierInverts) {
    return invertedChordHint(
      prefix,
      isMacPlatform() ? 'to open in Finder' : 'to open folder',
      'to switch workspace'
    )
  }

  return isMacPlatform()
    ? `${prefix}⌘+click to switch workspace, or ⇧⌘+click to open in Finder`
    : `${prefix}Ctrl+click to switch workspace, or Shift+Ctrl+click to open folder`
}
