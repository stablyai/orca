import {
  getOverlayFocusOwners,
  getOverlayFocusSources,
  isOverlayFocusSourceDismissed,
  subscribeOverlayFocusChanges
} from '@/lib/overlay-focus-ownership'

const PENDING_FOCUS_MS = 1000

type ComposerReclaim = (
  onlyIfFocusUnclaimed?: boolean,
  sourceOverlays?: readonly HTMLElement[]
) => void
const revealedComposerReclaims = new Map<
  string,
  { reclaim: ComposerReclaim; root: HTMLElement | null }
>()
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
  reclaim: ComposerReclaim,
  root: HTMLElement | null
): () => void {
  const destination = { reclaim, root }
  revealedComposerReclaims.set(tabId, destination)
  if (pendingFocusRequest?.tabId === tabId) {
    pendingFocusRequest.deliver()
  }
  return () => {
    if (revealedComposerReclaims.get(tabId) === destination) {
      revealedComposerReclaims.delete(tabId)
    }
  }
}

/** Keep a new-chat action's focus intent through source dismissal, destination claim, or expiry. */
export function captureNativeChatComposerFocusIntent(): NativeChatComposerFocusIntent {
  focusRequestGeneration += 1
  pendingFocusRequest?.cancel()
  if (typeof document === 'undefined') {
    return { request: () => undefined, cancel: () => undefined }
  }
  const sourceOverlays = getOverlayFocusSources()
  const cancel = (): void => {
    if (pendingFocusRequest !== pending) {
      return
    }
    pendingFocusRequest = null
    clearTimeout(timeout)
    unsubscribe()
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
    const destination = pending.tabId ? revealedComposerReclaims.get(pending.tabId) : undefined
    const sources = sourceOverlays.filter(
      (owner) => !destination?.root || !owner.contains(destination.root)
    )
    if (
      getOverlayFocusOwners(destination?.root ?? undefined).some(
        (owner) => !sourceOverlays.includes(owner)
      )
    ) {
      cancel()
      return
    }
    if (sources.some((owner) => !isOverlayFocusSourceDismissed(owner))) {
      return
    }
    if (destination) {
      cancel()
      destination.reclaim(false, sources)
    }
  }
  const pending: PendingComposerFocusRequest = { tabId: null, cancel, deliver }
  const unsubscribe = subscribeOverlayFocusChanges(deliver)
  const timeout = setTimeout(cancel, PENDING_FOCUS_MS)
  pendingFocusRequest = pending
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
    revealedComposerReclaims.get(tabId)?.reclaim(true)
    return
  }
  captureNativeChatComposerFocusIntent().request(tabId)
}
