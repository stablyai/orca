export const TERMINAL_COPY_MODE_ROOT_CLASS = 'terminal-copy-mode'

/** The copy-mode root sits inside its pane's container exactly while that pane's session is open. */
export function paneHasTerminalCopyMode(pane: {
  container: Pick<Element, 'querySelector'>
}): boolean {
  return pane.container.querySelector(`.${TERMINAL_COPY_MODE_ROOT_CLASS}`) !== null
}

const COPY_MODE_ALLOWED_TERMINAL_SHORTCUT_ACTIONS = new Set([
  'focusPane',
  'equalizePaneSizes',
  'toggleExpandActivePane',
  'closeActivePane',
  'splitActivePane',
  'switchInputSource'
])

export function isInsideTerminalCopyMode(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`.${TERMINAL_COPY_MODE_ROOT_CLASS}`) !== null
}

export function isCopyModeAllowedTerminalShortcutAction(actionType: string): boolean {
  return COPY_MODE_ALLOWED_TERMINAL_SHORTCUT_ACTIONS.has(actionType)
}
