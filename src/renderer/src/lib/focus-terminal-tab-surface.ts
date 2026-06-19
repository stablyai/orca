/**
 * Move keyboard focus into the xterm instance for a freshly-mounted terminal
 * tab. Handles the two-step race where React must first mount the new
 * TerminalPane/xterm before the hidden .xterm-helper-textarea exists —
 * double-rAF waits for that commit so focus lands on the new tab instead of
 * whatever surface (menu trigger, body, previous tab) just relinquished it.
 */
function cssAttributeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

let pendingFocusFrameIds: number[] = []

function cancelPendingFocusFrames(): void {
  if (typeof cancelAnimationFrame === 'function') {
    for (const frameId of pendingFocusFrameIds) {
      cancelAnimationFrame(frameId)
    }
  }
  pendingFocusFrameIds = []
}

export function focusTerminalTabSurface(tabId: string, leafId?: string | null): void {
  cancelPendingFocusFrames()
  const firstFrameId = requestAnimationFrame(() => {
    pendingFocusFrameIds = pendingFocusFrameIds.filter((frameId) => frameId !== firstFrameId)
    const secondFrameId = requestAnimationFrame(() => {
      pendingFocusFrameIds = pendingFocusFrameIds.filter((frameId) => frameId !== secondFrameId)
      // Why: this can be queued before inline tab rename mounts. If it runs
      // afterward, focusing xterm blurs the rename input and commits it closed.
      if (document.querySelector('[data-tab-rename-input="true"]')) {
        return
      }
      const escapedTabId = cssAttributeString(tabId)
      const scopedSelector = leafId
        ? `[data-terminal-tab-id="${escapedTabId}"] [data-leaf-id="${cssAttributeString(leafId)}"] .xterm-helper-textarea`
        : `[data-terminal-tab-id="${escapedTabId}"] .xterm-helper-textarea`
      const scoped = document.querySelector(scopedSelector) as HTMLElement | null
      if (scoped) {
        scoped.focus()
        return
      }
      if (leafId) {
        // Why: exact mobile split-pane focus must not silently focus a sibling
        // pane when the requested UUID leaf has not mounted yet.
        return
      }
      const fallback = document.querySelector('.xterm-helper-textarea') as HTMLElement | null
      fallback?.focus()
    })
    pendingFocusFrameIds.push(secondFrameId)
  })
  pendingFocusFrameIds.push(firstFrameId)
}
