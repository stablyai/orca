export const TERMINAL_COPY_MODE_ROOT_CLASS = 'terminal-copy-mode'

/** The copy-mode root sits inside its pane's container exactly while that pane's session is open. */
export function paneHasTerminalCopyMode(pane: {
  container: Pick<Element, 'querySelector'>
}): boolean {
  return pane.container.querySelector(`.${TERMINAL_COPY_MODE_ROOT_CLASS}`) !== null
}
