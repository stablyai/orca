/** The chat pane a dialog's opener sits in, read while the opener is still on screen. */
export function workerDockOpenerPane(opener: HTMLElement): Element | null {
  return opener.closest('[data-native-chat-root]')
}

/** That pane's message box, when focus the worker card held has nowhere left to go. */
export function focusWorkerDockPaneEditor(pane: Element | null | undefined): void {
  pane?.querySelector<HTMLElement>('[data-native-chat-prompt-editor]')?.focus()
}

/** Back to the row that opened a dialog; once that row is gone, its own pane's worker pill; once
 *  the last worker left too, that pane's message box. Never another pane, never the page. */
export function returnWorkerDockFocus(opener: HTMLElement, pane: Element | null): void {
  if (opener.isConnected) {
    opener.focus()
    return
  }
  const pill = pane?.querySelector<HTMLElement>('[data-worker-dock-pill]')
  if (pill) {
    pill.focus()
  } else {
    focusWorkerDockPaneEditor(pane)
  }
}
