import {
  keybindingMatchesAction,
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
const FLOATING_WORKSPACE_PANEL_SHORTCUT_ACTIONS: readonly KeybindingActionId[] = [
  'tab.newTerminal',
  'tab.newBrowser',
  'tab.newMarkdown',
  'tab.openMarkdown',
  'tab.close'
]

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
  return FLOATING_WORKSPACE_PANEL_SHORTCUT_ACTIONS.some((actionId) =>
    keybindingMatchesAction(actionId, event, platform, keybindings, options)
  )
}
