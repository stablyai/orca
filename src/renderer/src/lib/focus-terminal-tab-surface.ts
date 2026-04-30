/**
 * Move keyboard focus into the xterm instance for a freshly-mounted terminal
 * tab. Handles the two-step race where React must first mount the new
 * TerminalPane/xterm before the hidden .xterm-helper-textarea exists —
 * double-rAF waits for that commit so focus lands on the new tab instead of
 * whatever surface (menu trigger, body, previous tab) just relinquished it.
 */
export function focusTerminalTabSurface(tabId: string): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const scoped = document.querySelector(
        `[data-terminal-tab-id="${tabId}"] .xterm-helper-textarea`
      ) as HTMLElement | null
      if (scoped) {
        scoped.focus()
        return
      }
      const fallback = document.querySelector('.xterm-helper-textarea') as HTMLElement | null
      fallback?.focus()
    })
  })
}
