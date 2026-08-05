import { refreshTerminalImeInputContext } from '@/components/terminal-pane/terminal-ime-input-context-refresh'
import { paneContainerOwnsFocus } from '@/lib/pane-manager/pane-pointer-focus'

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

type FocusTerminalTabSurfaceOptions = {
  onlyIfFocusUnclaimed?: boolean
  onImeRefocusSkipped?: (activeElement: Element | null) => void
  refreshImeContext?: boolean
}

function focusTerminalHelper(helper: HTMLElement, options: FocusTerminalTabSurfaceOptions): void {
  if (options.onlyIfFocusUnclaimed) {
    const active = document.activeElement
    if (active !== helper && active !== null && active !== document.body) {
      return
    }
  }
  // Why: a pane showing the native chat composer owns its own focus (see
  // shouldAutofocusNativeChatComposer) — this double-rAF-delayed reclaim must
  // not steal it back onto the hidden xterm underneath. The composer overlay
  // is a DOM sibling of the xterm container (both children of .pane), not an
  // ancestor of `helper`, so check the shared pane container, not `closest`.
  const paneContainer = helper.closest('.pane') as HTMLElement | null
  if (paneContainer && paneContainerOwnsFocus(paneContainer)) {
    return
  }
  helper.focus()
  if (options.refreshImeContext) {
    // Why: a CSS-hidden, long-lived xterm can retain a stale macOS native text
    // input context even after DOM focus returns; blur/refocus rebuilds it.
    refreshTerminalImeInputContext(helper, {
      onRefocusSkipped: options.onImeRefocusSkipped
    })
  }
}

function cancelPendingFocusFrames(): void {
  if (typeof cancelAnimationFrame === 'function') {
    for (const frameId of pendingFocusFrameIds) {
      cancelAnimationFrame(frameId)
    }
  }
  pendingFocusFrameIds = []
}

function canUseSinglePaneStaleLeafFallback(tabId: string, leafId: string): boolean {
  const tabElement = document.querySelector(`[data-terminal-tab-id="${cssAttributeString(tabId)}"]`)
  const expectedLeafIds = tabElement
    ?.getAttribute('data-terminal-layout-leaf-ids')
    ?.split(' ')
    .filter(Boolean)
  return expectedLeafIds?.length === 1 && !expectedLeafIds.includes(leafId)
}

export function focusTerminalTabSurface(
  tabId: string,
  leafId?: string | null,
  options: FocusTerminalTabSurfaceOptions = {}
): void {
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
        focusTerminalHelper(scoped, options)
        return
      }
      if (leafId) {
        if (!canUseSinglePaneStaleLeafFallback(tabId, leafId)) {
          // Why: exact mobile split-pane focus must not silently focus a sibling
          // pane when the requested UUID leaf has not mounted yet.
          return
        }
        // Why: old single-pane remounts could remint the leaf id. Only recover
        // after the tab layout no longer expects the requested leaf.
        const tabScopedHelpers = document.querySelectorAll(
          `[data-terminal-tab-id="${escapedTabId}"] .xterm-helper-textarea`
        )
        if (tabScopedHelpers.length === 1) {
          const fallback = tabScopedHelpers.item(0) as HTMLElement | null
          if (fallback) {
            focusTerminalHelper(fallback, options)
          }
          return
        }
        return
      }
      const fallback = document.querySelector('.xterm-helper-textarea') as HTMLElement | null
      if (fallback) {
        focusTerminalHelper(fallback, options)
      }
    })
    pendingFocusFrameIds.push(secondFrameId)
  })
  pendingFocusFrameIds.push(firstFrameId)
}
