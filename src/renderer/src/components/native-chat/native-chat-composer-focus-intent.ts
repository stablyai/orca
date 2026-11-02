import { getVisibleOverlays } from '@/lib/visible-overlay'

const PENDING_FOCUS_MS = 1000

type ComposerReclaim = (
  onlyIfFocusUnclaimed?: boolean,
  sourceOverlays?: readonly HTMLElement[]
) => void
const revealedComposerReclaims = new Map<string, ComposerReclaim>()
type PendingComposerFocusRequest = {
  tabId: string | null
  cancel: () => void
  deliver: () => void
}
let pendingFocusRequest: PendingComposerFocusRequest | null = null
let focusRequestGeneration = 0

export type NativeChatComposerFocusIntent = {
  request: (tabId: string) => void
  cancel: () => void
}

export function getNativeChatComposerFocusRequestGeneration(): number {
  return focusRequestGeneration
}

export function registerNativeChatComposerReclaim(
  tabId: string,
  reclaim: ComposerReclaim
): () => void {
  revealedComposerReclaims.set(tabId, reclaim)
  if (pendingFocusRequest?.tabId === tabId) {
    pendingFocusRequest.deliver()
  }
  return () => {
    if (revealedComposerReclaims.get(tabId) === reclaim) {
      revealedComposerReclaims.delete(tabId)
    }
  }
}

/** Keep a new-chat action's focus intent through source dismissal, destination claim, or expiry. */
export function captureNativeChatComposerFocusIntent(): NativeChatComposerFocusIntent {
  return captureFocusIntent(true)
}

function captureFocusIntent(waitForSourceOverlays: boolean): NativeChatComposerFocusIntent {
  focusRequestGeneration += 1
  pendingFocusRequest?.cancel()
  if (typeof document === 'undefined') {
    return { request: () => undefined, cancel: () => undefined }
  }
  const sourceOverlays = new Set(
    waitForSourceOverlays ? getVisibleOverlays({ ignoreDismissed: true }) : []
  )
  const originalOverlays = [...sourceOverlays]
  const watchOverlays = sourceOverlays.size > 0
  const cancel = (): void => {
    if (pendingFocusRequest !== pending) {
      return
    }
    pendingFocusRequest = null
    clearTimeout(timeout)
    observer?.disconnect()
    document.removeEventListener('pointerdown', cancel, true)
    document.removeEventListener('keydown', cancelForNavigation, true)
  }
  const cancelForNavigation = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') {
      cancel()
    }
  }
  const deliver = (): void => {
    if (pendingFocusRequest !== pending) {
      return
    }
    if (watchOverlays) {
      const overlays = getVisibleOverlays({ ignoreDismissed: true })
      if (overlays.some((overlay) => !sourceOverlays.has(overlay))) {
        cancel()
        return
      }
      for (const overlay of sourceOverlays) {
        if (!overlays.includes(overlay)) {
          sourceOverlays.delete(overlay)
        }
      }
      if (overlays.length > 0) {
        return
      }
    }
    const reclaim = pending.tabId ? revealedComposerReclaims.get(pending.tabId) : undefined
    if (reclaim) {
      cancel()
      reclaim(false, originalOverlays)
    }
  }
  const pending: PendingComposerFocusRequest = { tabId: null, cancel, deliver }
  const observer = watchOverlays ? new MutationObserver(deliver) : null
  const timeout = setTimeout(cancel, PENDING_FOCUS_MS)
  pendingFocusRequest = pending
  observer?.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-state', 'aria-hidden', 'hidden', 'role']
  })
  document.addEventListener('pointerdown', cancel, true)
  document.addEventListener('keydown', cancelForNavigation, true)
  return {
    request: (tabId) => {
      if (pendingFocusRequest !== pending) {
        return
      }
      pending.tabId = tabId
      deliver()
    },
    cancel
  }
}

/** Re-clicking a chat's active tab claims its composer again, as a terminal tab refocuses xterm. */
export function requestNativeChatComposerFocus(
  tabId: string,
  options: { onlyIfFocusUnclaimed?: boolean } = {}
): void {
  if (options.onlyIfFocusUnclaimed) {
    // A rename return is one-shot, not an activation to replay after a hidden composer reveals.
    revealedComposerReclaims.get(tabId)?.(true)
    return
  }
  captureFocusIntent(false).request(tabId)
}
