import {
  keybindingMatchesAction,
  matchKeybindingDigitIndex,
  type KeybindingActionId,
  type KeybindingMatchOptions,
  type KeybindingOverrides,
  type PhysicalModifierToken
} from '../../../shared/keybindings'

// Partial<> on the key/modifier fields so a synthetic double-tap input (which
// carries no key/modifier flags) satisfies this shape; target stays required.
type FloatingWorkspaceShortcutEvent = Partial<
  Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>
> &
  Pick<KeyboardEvent, 'target'> & { doubleTapModifier?: PhysicalModifierToken }

const FLOATING_WORKSPACE_SHORTCUT_SURFACE_SELECTOR = '[data-floating-terminal-shortcut-surface]'
const FLOATING_WORKSPACE_PANEL_SHORTCUT_ACTIONS = [
  'tab.newTerminal',
  'tab.newBrowser',
  'tab.newMarkdown',
  'tab.openMarkdown',
  'tab.close'
] as const satisfies readonly KeybindingActionId[]

export type FloatingWorkspacePanelOwnedAction =
  (typeof FLOATING_WORKSPACE_PANEL_SHORTCUT_ACTIONS)[number]

function defaultIsMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

export function isFloatingWorkspacePanelShortcutTarget(
  target: EventTarget | null,
  panelRoot: HTMLElement | null = null
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return (
    target === panelRoot ||
    target.getAttribute('data-floating-terminal-panel') !== null ||
    target.closest(FLOATING_WORKSPACE_SHORTCUT_SURFACE_SELECTOR) !== null
  )
}

// Which tab-creation/close action the panel claims, without the target gate — the panel's own
// window-capture dispatch owns chords from anywhere inside the panel (xterm, browser slot, editor),
// not just its shortcut surface. Returning the identity lets one pass serve both the claim check and
// the dispatch branch.
export function matchFloatingWorkspacePanelOwnedAction(
  event: FloatingWorkspaceShortcutEvent,
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides | undefined,
  options: KeybindingMatchOptions
): FloatingWorkspacePanelOwnedAction | null {
  return (
    FLOATING_WORKSPACE_PANEL_SHORTCUT_ACTIONS.find((actionId) =>
      keybindingMatchesAction(actionId, event, platform, keybindings, options)
    ) ?? null
  )
}

export function isFloatingWorkspacePanelShortcut(
  event: FloatingWorkspaceShortcutEvent,
  platformOrIsMac: NodeJS.Platform | boolean = defaultIsMacPlatform(),
  panelRoot: HTMLElement | null = null,
  keybindings?: KeybindingOverrides,
  options: KeybindingMatchOptions = {}
): boolean {
  if (!isFloatingWorkspacePanelShortcutTarget(event.target, panelRoot)) {
    return false
  }
  const platform: NodeJS.Platform =
    typeof platformOrIsMac === 'boolean' ? (platformOrIsMac ? 'darwin' : 'linux') : platformOrIsMac
  return matchFloatingWorkspacePanelOwnedAction(event, platform, keybindings, options) !== null
}

export type FloatingWorkspacePanelShortcutMatch =
  | { readonly kind: 'action'; readonly action: KeybindingActionId }
  | { readonly kind: 'index'; readonly index: number }

// Single source of truth for the panel's non-creation shortcut claims (title rename, indexed switch,
// window max/min) so the dispatch, its keydown preflight, and App.tsx's yield gate can't drift and
// silently reintroduce the routing bug. Index precedence is workspace-then-tab, mirroring the
// main-window resolver. Chrome actions take their own options (under terminal-first a focused xterm
// resolves them in app context); the index match uses `options`.
export function matchFloatingWorkspacePanelShortcut(
  event: FloatingWorkspaceShortcutEvent,
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides | undefined,
  options: KeybindingMatchOptions,
  chromeOptions: KeybindingMatchOptions = options
): FloatingWorkspacePanelShortcutMatch | null {
  if (keybindingMatchesAction('tab.rename', event, platform, keybindings, chromeOptions)) {
    return { kind: 'action', action: 'tab.rename' }
  }
  const index =
    matchKeybindingDigitIndex('workspace.selectByIndex', event, platform, keybindings, options) ??
    matchKeybindingDigitIndex('tab.selectByIndex', event, platform, keybindings, options)
  if (index !== null) {
    return { kind: 'index', index }
  }
  if (
    keybindingMatchesAction(
      'floatingWorkspace.maximize',
      event,
      platform,
      keybindings,
      chromeOptions
    )
  ) {
    return { kind: 'action', action: 'floatingWorkspace.maximize' }
  }
  if (
    keybindingMatchesAction(
      'floatingWorkspace.minimize',
      event,
      platform,
      keybindings,
      chromeOptions
    )
  ) {
    return { kind: 'action', action: 'floatingWorkspace.minimize' }
  }
  return null
}

// Everything the panel claims, resolved in one call for claim-only callers like App.tsx's yield gate
// (which otherwise pairs the two matchers by hand and can drift from the dispatch). Creation chords
// stay target-gated; chrome chords stay ungated — same order and semantics as the matchers it composes.
export function matchFloatingWorkspacePanelChord(
  event: FloatingWorkspaceShortcutEvent,
  platform: NodeJS.Platform,
  panelRoot: HTMLElement | null,
  keybindings: KeybindingOverrides | undefined,
  options: KeybindingMatchOptions,
  chromeOptions: KeybindingMatchOptions = options
): FloatingWorkspacePanelShortcutMatch | null {
  const ownedAction = isFloatingWorkspacePanelShortcutTarget(event.target, panelRoot)
    ? matchFloatingWorkspacePanelOwnedAction(event, platform, keybindings, options)
    : null
  if (ownedAction) {
    return { kind: 'action', action: ownedAction }
  }
  return matchFloatingWorkspacePanelShortcut(event, platform, keybindings, options, chromeOptions)
}
