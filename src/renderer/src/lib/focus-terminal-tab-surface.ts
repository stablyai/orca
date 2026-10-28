import { refreshTerminalImeInputContext } from '@/components/terminal-pane/terminal-ime-input-context-refresh'
import { UNCOVERED_TERMINAL_LEAF_SELECTOR } from '@/components/terminal-pane/native-chat-covered-pane'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'

/** Wait two frames for a fresh tab’s xterm textarea to mount so focus cannot land on the menu/body/previous tab. */
function cssAttributeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

let pendingFocusFrameIds: number[] = []

type FocusTerminalTabSurfaceOptions = {
  /** Already-visible panels can take input in the click event, before the next frame. */
  immediate?: boolean
  onlyWithinTab?: boolean
  onlyIfFocusUnclaimed?: boolean
  /** Rename return only: claim an idle chat composer now instead of queueing a replayable reveal request. */
  oneShotChatComposerFocus?: boolean
  shouldFocus?: () => boolean
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
  helper.focus()
  if (options.refreshImeContext) {
    // Blur/refocus refreshes stale macOS text-input context retained by long-hidden xterms.
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
  const applyFocus = (): void => {
    // Why: this can be queued before inline tab rename mounts. If it runs
    // afterward, focusing xterm blurs the rename input and commits it closed.
    if (
      options.shouldFocus?.() === false ||
      document.querySelector('[data-tab-rename-input="true"]')
    ) {
      return
    }
    const escapedTabId = cssAttributeString(tabId)
    const tabElement = document.querySelector(`[data-terminal-tab-id="${escapedTabId}"]`)
    if (tabElement?.getAttribute('data-terminal-chat-view') === 'true') {
      // The chat over this terminal takes the focus in its composer instead.
      if (!options.onlyIfFocusUnclaimed || document.activeElement === document.body) {
        if (options.oneShotChatComposerFocus) {
          requestNativeChatComposerFocus(tabId, { onlyIfFocusUnclaimed: true })
          return
        }
        requestNativeChatComposerFocus(tabId)
      }
      return
    }
    // Why: a split chat tab keeps a covered xterm under the chat leaf; the
    // tab-wide query must skip it or the deferred focus lands on it.
    const scopedSelector = leafId
      ? `[data-terminal-tab-id="${escapedTabId}"] [data-leaf-id="${cssAttributeString(leafId)}"]${UNCOVERED_TERMINAL_LEAF_SELECTOR} .xterm-helper-textarea`
      : `[data-terminal-tab-id="${escapedTabId}"] ${UNCOVERED_TERMINAL_LEAF_SELECTOR} .xterm-helper-textarea`
    // A pane-specific reveal may have focused a split while this tab-wide request was waiting.
    const scoped =
      (!leafId ? document.querySelector<HTMLElement>(`${scopedSelector}:focus`) : null) ??
      document.querySelector<HTMLElement>(scopedSelector)
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
        `[data-terminal-tab-id="${escapedTabId}"] ${UNCOVERED_TERMINAL_LEAF_SELECTOR} .xterm-helper-textarea`
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
    if (options.onlyWithinTab) {
      return
    }
    const fallback = document.querySelector(
      `${UNCOVERED_TERMINAL_LEAF_SELECTOR} .xterm-helper-textarea`
    ) as HTMLElement | null
    if (fallback) {
      focusTerminalHelper(fallback, options)
    }
  }
  if (options.immediate) {
    applyFocus()
    if (document.activeElement?.closest(`[data-terminal-tab-id="${cssAttributeString(tabId)}"]`)) {
      return
    }
  }
  const firstFrameId = requestAnimationFrame(() => {
    pendingFocusFrameIds = pendingFocusFrameIds.filter((frameId) => frameId !== firstFrameId)
    const secondFrameId = requestAnimationFrame(() => {
      pendingFocusFrameIds = pendingFocusFrameIds.filter((frameId) => frameId !== secondFrameId)
      applyFocus()
    })
    pendingFocusFrameIds.push(secondFrameId)
  })
  pendingFocusFrameIds.push(firstFrameId)
}
