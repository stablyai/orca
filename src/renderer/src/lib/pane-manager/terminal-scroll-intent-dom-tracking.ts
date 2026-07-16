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
import type { TerminalScrollIntentKey, TerminalScrollIntentTarget } from './terminal-scroll-intent'
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

// Mouse reports (SGR "\x1b[<b;x;yM" and X10 "\x1b[M...") stream at pointer
// frequency and are the one input kind whose native scroll-to-bottom must NOT
// reclassify a pin: converting it would permanently drop a reading position
// on a mere mouse-move over a mouse-tracking app.
function isMouseReportInput(data: string): boolean {
  return (
    data.charCodeAt(0) === 0x1b &&
    data.charAt(1) === '[' &&
    (data.charAt(2) === '<' || data.charAt(2) === 'M')
  )
}

// Why: typing/pasting scrolls the terminal to the bottom (xterm
// scrollOnUserInput) without going through any wheel/pointer path this module
// tracks. Without a resync, a stored pin goes stale and a later
// workspace-switch restore yanks the user back to the old reading position.
// onData also carries parser auto-replies (DSR/CPR, focus reports), so pinned
// xterm's core onUserInput signal identifies which emissions were truly user-driven.
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
          // Why: xterm treats mouse reports as user input and scrolls bottom
          // before onData. Restore the reading position before output follows.
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
        // Compatibility fallback for test doubles or an unexpected xterm
        // shape; pinned production xterm uses onUserInput below.
        resyncUserInput(captureInteractionRevision())
      }
    })
    const userInputSubscription = onUserInput?.(() => {
      // Why: xterm emits onUserInput immediately before its matching onData.
      // Reserve order here, then let onData classify typing versus mouse.
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

/** Wires the user-driven scroll signals (wheel, scrollbar pointer drags) that
 *  are allowed to change a terminal's scroll intent. Output-driven scroll
 *  events deliberately do not update intent (see terminal-scroll-intent.ts). */
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
          // Why: wheel/scrollbar movement during replay must be sampled from
          // the completed buffer, never from its transient cleared rows.
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
            // Why: an upward wheel or scrollbar gesture against the cleared 0/0
            // buffer must not erase the durable pin. Settle after restoration so
            // a real move wins and a no-op gesture can still return to follow.
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
      // Why: native pinned output can grow baseY without a DOM scroll event;
      // persist that geometry before remount, but never let an old instance
      // overwrite a successor already bound to the same leaf key.
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
