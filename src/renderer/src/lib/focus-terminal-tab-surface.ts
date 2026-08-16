import { refreshTerminalImeInputContext } from '@/components/terminal-pane/terminal-ime-input-context-refresh'
import { getPaneDocuments } from '@/lib/aux-pane-window-registry'

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
    const paneDocument = helper.ownerDocument ?? document
    const active = paneDocument.activeElement
    if (active !== helper && active !== null && active !== paneDocument.body) {
      return
    }
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

function canUseSinglePaneStaleLeafFallback(
  paneDocument: Document,
  tabId: string,
  leafId: string
): boolean {
  const tabElement = paneDocument.querySelector(
    `[data-terminal-tab-id="${cssAttributeString(tabId)}"]`
  )
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
      const escapedTabId = cssAttributeString(tabId)
      const scopedSelector = leafId
        ? `[data-terminal-tab-id="${escapedTabId}"] [data-leaf-id="${cssAttributeString(leafId)}"] .xterm-helper-textarea`
        : `[data-terminal-tab-id="${escapedTabId}"] .xterm-helper-textarea`
      const paneDocuments = getPaneDocuments()
      const paneDocument =
        paneDocuments.find((candidate) => candidate.querySelector(scopedSelector)) ?? null
      // Why: this can be queued before inline tab rename mounts. If it runs
      // afterward, focusing xterm blurs the rename input and commits it closed.
      if (paneDocument?.querySelector('[data-tab-rename-input="true"]')) {
        return
      }
      const scoped = paneDocument?.querySelector(scopedSelector) as HTMLElement | null
      if (scoped) {
        focusTerminalHelper(scoped, options)
        return
      }
      if (leafId) {
        const tabDocument =
          paneDocuments.find((candidate) =>
            candidate.querySelector(`[data-terminal-tab-id="${escapedTabId}"]`)
          ) ?? null
        if (!tabDocument || !canUseSinglePaneStaleLeafFallback(tabDocument, tabId, leafId)) {
          // Why: exact mobile split-pane focus must not silently focus a sibling
          // pane when the requested UUID leaf has not mounted yet.
          return
        }
        // Why: old single-pane remounts could remint the leaf id. Only recover
        // after the tab layout no longer expects the requested leaf.
        const tabScopedHelpers = tabDocument.querySelectorAll(
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
      const fallbackDocument =
        paneDocuments.find((candidate) => candidate.hasFocus?.() === true) ?? paneDocuments[0]
      const fallback = fallbackDocument?.querySelector(
        '.xterm-helper-textarea'
      ) as HTMLElement | null
      if (fallback) {
        focusTerminalHelper(fallback, options)
      }
    })
    pendingFocusFrameIds.push(secondFrameId)
  })
  pendingFocusFrameIds.push(firstFrameId)
}
