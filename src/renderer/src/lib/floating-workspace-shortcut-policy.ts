import {
  keybindingMatchesAction,
  matchKeybindingDigitIndex,
  type KeybindingActionId,
  type KeybindingMatchOptions,
  type KeybindingOverrides,
  type PhysicalModifierToken
} from '../../../shared/keybindings'

// Allow synthetic double-tap inputs without key/modifier fields, but still require their event target.
type FloatingWorkspaceShortcutEvent = Partial<
  Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>
> &
  Pick<KeyboardEvent, 'target'> & { doubleTapModifier?: PhysicalModifierToken }

// Why the tab strips: they are the floating panel's titlebar, so panel shortcuts apply there too.
export const FLOATING_WORKSPACE_SHORTCUT_SURFACE_SELECTOR =
  '[data-floating-terminal-shortcut-surface], [data-floating-terminal-panel] [data-tab-group-strip-id]'
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

/** Resolve creation/close identity once for claim and dispatch; panel capture owns chords across xterm, browser and editor targets. */
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

/** Share chrome claims across dispatch/preflight/App yield; workspace indexes precede tab indexes, while chrome actions use their own context options. */
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

/** Combine target-gated creation and ungated chrome claims in dispatch order so claim-only callers cannot drift. */
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
