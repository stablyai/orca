import type { IDisposable } from '@xterm/xterm'
import {
  bindTerminalScrollIntentKey,
  enforceTerminalCurrentScrollIntent,
  getTerminalScrollIntentKind,
  isTerminalScrollIntentKeyBindingCurrent,
  markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport
} from './terminal-scroll-intent'
import { syncTerminalScrollIntentSoon } from './terminal-scroll-intent-settle'
import type { TerminalScrollIntentTarget } from './terminal-scroll-intent'
import type { TerminalScrollIntentKey } from './terminal-scroll-intent-key-store'
import {
  isTerminalScrollIntentRebuildInFlight,
  onTerminalScrollIntentBufferRebuildComplete
} from './terminal-scroll-intent-rebuild'

const XTERM_SCROLL_INTENT_POINTER_TARGET_CLASSES = [
  'xterm-viewport',
  'xterm-scrollbar',
  'xterm-slider'
] as const
const XTERM_SCROLL_INTENT_POINTER_TARGET_SELECTOR = XTERM_SCROLL_INTENT_POINTER_TARGET_CLASSES.map(
  (className) => `.${className}`
).join(',')

function isTerminalScrollIntentPointerTarget(target: EventTarget | null): target is Element {
  if (typeof Element === 'undefined' || !(target instanceof Element)) {
    return false
  }
  // xterm's custom scrollbar uses separate thumb/track nodes from the viewport.
  return target.closest(XTERM_SCROLL_INTENT_POINTER_TARGET_SELECTOR) !== null
}

type TerminalWithOnData = {
  onData?: (listener: (data: string) => void) => { dispose?: unknown } | undefined
  _core?: {
    coreService?: {
      onUserInput?: (listener: () => void) => { dispose?: unknown } | undefined
    }
  }
}

// Mouse reports scroll xterm to bottom as input but must not erase the reader’s pin merely from pointer movement.
function isMouseReportInput(data: string): boolean {
  return (
    data.charCodeAt(0) === 0x1b &&
    data.charAt(1) === '[' &&
    (data.charAt(2) === '<' || data.charAt(2) === 'M')
  )
}

// Typing/paste scrolls bottom outside wheel/pointer paths; resync intent to avoid restoring a stale pin. onData includes parser replies, so pinned-core onUserInput identifies actual input.
function subscribeScrollIntentUserInputResync(
  terminal: TerminalScrollIntentTarget,
  isActive: () => boolean,
  captureInteractionRevision: () => number,
  resyncUserInput: (interactionRevision: number) => void
): { dispose: () => void } | null {
  const terminalWithInput = terminal as TerminalWithOnData
  const onData = terminalWithInput.onData
  if (typeof onData !== 'function') {
    return null
  }
  const onUserInput = terminalWithInput._core?.coreService?.onUserInput
  let pendingUserInputRevision: number | null = null
  try {
    const dataSubscription = onData((data: string) => {
      if (isMouseReportInput(data)) {
        pendingUserInputRevision = null
        if (isActive() && getTerminalScrollIntentKind(terminal) === 'pinnedViewport') {
          // xterm scrolls bottom before onData for mouse reports; restore the pin before output follows.
          enforceTerminalCurrentScrollIntent(terminal)
        }
        return
      }
      if (typeof onUserInput === 'function') {
        const interactionRevision = pendingUserInputRevision
        pendingUserInputRevision = null
        if (interactionRevision !== null && isActive()) {
          resyncUserInput(interactionRevision)
        }
      } else if (isActive()) {
        // Fallback for test doubles/unexpected xterm shape; production uses onUserInput below.
        resyncUserInput(captureInteractionRevision())
      }
    })
    const userInputSubscription = onUserInput?.(() => {
      // onUserInput immediately precedes matching onData; reserve order, then classify typing versus mouse.
      pendingUserInputRevision = captureInteractionRevision()
    })
    return {
      dispose: () => {
        if (dataSubscription && typeof dataSubscription.dispose === 'function') {
          dataSubscription.dispose()
        }
        if (userInputSubscription && typeof userInputSubscription.dispose === 'function') {
          userInputSubscription.dispose()
        }
      }
    }
  } catch {
    return null
  }
}

/** Track wheel/scrollbar user intent; output-driven scroll deliberately leaves it unchanged (terminal-scroll-intent.ts). */
export function attachTerminalScrollIntentTracking(
  terminal: TerminalScrollIntentTarget,
  host: HTMLElement,
  intentKey?: TerminalScrollIntentKey
): IDisposable {
  if (!bindTerminalScrollIntentKey(terminal, intentKey)) {
    syncTerminalScrollIntentFromViewport(terminal)
  }
  let disposed = false
  const isActive = (): boolean => !disposed
  let pointerScrollActive = false
  let cancelPostRebuildSync: (() => void) | null = null
  let nextInteractionRevision = 0
  let latestCommittedInteractionRevision = 0
  let postRebuildSync: { revision: number; mode: 'sample' | 'preservePinnedAtBottom' } | null = null
  const captureInteractionRevision = (): number => (nextInteractionRevision += 1)

  const syncFromViewportOrAfterRebuild = (
    mode: 'sample' | 'preservePinnedAtBottom' = 'sample',
    interactionRevision = captureInteractionRevision()
  ): boolean => {
    if (interactionRevision < latestCommittedInteractionRevision) {
      return false
    }
    latestCommittedInteractionRevision = interactionRevision
    if (!isTerminalScrollIntentRebuildInFlight(terminal)) {
      syncTerminalScrollIntentFromViewport(terminal, { allowBufferShrink: true })
      return true
    }
    postRebuildSync = { revision: interactionRevision, mode }
    if (!cancelPostRebuildSync) {
      cancelPostRebuildSync = onTerminalScrollIntentBufferRebuildComplete(terminal, (completed) => {
        cancelPostRebuildSync = null
        const pendingSync = postRebuildSync
        postRebuildSync = null
        if (
          completed &&
          isActive() &&
          pendingSync &&
          pendingSync.revision === latestCommittedInteractionRevision
        ) {
          // Sample replay-time gestures only after the completed buffer replaces transient cleared rows.
          const preservePinnedAtBottom = pendingSync.mode === 'preservePinnedAtBottom'
          if (
            preservePinnedAtBottom &&
            getTerminalScrollIntentKind(terminal) !== 'pinnedViewport'
          ) {
            markTerminalPinnedViewport(terminal)
          }
          syncTerminalScrollIntentFromViewport(terminal, {
            allowBufferShrink: true,
            preservePinnedAtBottom
          })
          if (preservePinnedAtBottom) {
            // Gestures against cleared 0/0 must preserve durable pins; settle after restoration so genuine movement wins and no-op gestures can still follow.
            syncTerminalScrollIntentSoon(terminal, {
              allowBufferShrink: true,
              preservePinnedAtBottom: true,
              shouldSync: isActive
            })
          }
        }
      })
    }
    return false
  }
  const userInputResync = subscribeScrollIntentUserInputResync(
    terminal,
    isActive,
    captureInteractionRevision,
    (interactionRevision) => syncFromViewportOrAfterRebuild('sample', interactionRevision)
  )

  const onWheel = (event: WheelEvent): void => {
    if (!syncFromViewportOrAfterRebuild(event.deltaY < 0 ? 'preservePinnedAtBottom' : 'sample')) {
      return
    }
    if (event.deltaY < 0) {
      markTerminalPinnedViewport(terminal)
      syncTerminalScrollIntentSoon(terminal, {
        preservePinnedAtBottom: true,
        shouldSync: isActive
      })
      return
    }
    syncTerminalScrollIntentSoon(terminal, { shouldSync: isActive })
  }

  const onPointerDown = (event: PointerEvent): void => {
    pointerScrollActive = isTerminalScrollIntentPointerTarget(event.target)
  }

  const onPointerDone = (): void => {
    if (!pointerScrollActive) {
      return
    }
    pointerScrollActive = false
    syncFromViewportOrAfterRebuild('preservePinnedAtBottom')
  }

  const onScroll = (): void => {
    if (pointerScrollActive) {
      syncFromViewportOrAfterRebuild('preservePinnedAtBottom')
    }
  }

  host.addEventListener('wheel', onWheel, { capture: true, passive: true })
  host.addEventListener('pointerdown', onPointerDown, true)
  host.addEventListener('scroll', onScroll, true)
  globalThis.addEventListener?.('pointerup', onPointerDone, true)
  globalThis.addEventListener?.('pointercancel', onPointerDone, true)
  return {
    dispose: () => {
      // Persist baseY growth even without DOM scroll events before remount; old instances must never overwrite a successor on the same leaf.
      if (isTerminalScrollIntentKeyBindingCurrent(terminal)) {
        syncTerminalScrollIntentFromViewport(terminal)
      }
      disposed = true
      cancelPostRebuildSync?.()
      cancelPostRebuildSync = null
      postRebuildSync = null
      userInputResync?.dispose()
      host.removeEventListener('wheel', onWheel, true)
      host.removeEventListener('pointerdown', onPointerDown, true)
      host.removeEventListener('scroll', onScroll, true)
      globalThis.removeEventListener?.('pointerup', onPointerDone, true)
      globalThis.removeEventListener?.('pointercancel', onPointerDone, true)
    }
  }
}
