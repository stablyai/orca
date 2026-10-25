import { refreshTerminalImeInputContext } from '@/components/terminal-pane/terminal-ime-input-context-refresh'
import { UNCOVERED_TERMINAL_LEAF_SELECTOR } from '@/components/terminal-pane/native-chat-covered-pane'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'

/** Wait two frames for a fresh tab’s xterm textarea to mount so focus cannot land on the menu/body/previous tab. */
function cssAttributeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

let pendingFocusFrameIds: number[] = []

type FocusTerminalTabSurfaceOptions = {
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
  const firstFrameId = requestAnimationFrame(() => {
    pendingFocusFrameIds = pendingFocusFrameIds.filter((frameId) => frameId !== firstFrameId)
    const secondFrameId = requestAnimationFrame(() => {
      pendingFocusFrameIds = pendingFocusFrameIds.filter((frameId) => frameId !== secondFrameId)
      // A queued focus may run after inline rename mounts; do not blur and prematurely commit its input.
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
      // Skip xterms covered by split chat portals so tab-wide deferred focus cannot steal composer focus.
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
          // Mobile UUID-leaf focus must wait for that pane rather than silently focus a sibling.
          return
        }
        // Recover legacy reminted leaves only after layout stops expecting the requested ID.
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
      const fallback = document.querySelector(
        `${UNCOVERED_TERMINAL_LEAF_SELECTOR} .xterm-helper-textarea`
      ) as HTMLElement | null
      if (fallback) {
        focusTerminalHelper(fallback, options)
      }
    })
    pendingFocusFrameIds.push(secondFrameId)
  })
  pendingFocusFrameIds.push(firstFrameId)
}
