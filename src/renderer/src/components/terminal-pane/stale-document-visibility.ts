// Chromium's macOS window-occlusion tracker can wedge document.visibilityState
// at 'hidden' after display sleep, never firing another visibilitychange. Real
// user input reaching this window while the document claims hidden is a
// physical contradiction — keystrokes and clicks only reach a focused,
// on-screen window. This module latches that proof so terminal delivery can
// treat the document as visible until the next genuine visibilitychange
// restores trust in the occlusion tracker. Without it, the hidden-delivery
// gate stays latched for panes the user is looking at and main drops their
// bytes indefinitely (field: 78MB dropped on 2 visible ptys, v1.4.124-rc.2.perf).

import { recordTerminalFreezeBreadcrumb } from './terminal-freeze-breadcrumbs'

type StaleVisibilityRecoveryListener = () => void

const recoveryListeners = new Set<StaleVisibilityRecoveryListener>()
let visibilityProvenStale = false
let globalListenersInstalled = false

export function isDocumentVisibilityProvenStale(): boolean {
  return visibilityProvenStale
}

function onUserInteractionWithDocument(): void {
  if (visibilityProvenStale || document.visibilityState !== 'hidden') {
    return
  }
  visibilityProvenStale = true
  recordTerminalFreezeBreadcrumb('stale-visibility-latch', {
    recoveryListenerCount: recoveryListeners.size
  })
  console.warn(
    '[terminal] user input arrived while document.visibilityState is hidden — treating occlusion state as stale and re-syncing terminal delivery',
    { recoveryListenerCount: recoveryListeners.size }
  )
  for (const listener of recoveryListeners) {
    try {
      listener()
    } catch {
      // Why: one pane's recovery failure must not starve the other panes'.
    }
  }
}

function onDocumentVisibilityChange(): void {
  recordTerminalFreezeBreadcrumb('visibilitychange', {
    state: document.visibilityState,
    clearedStaleOverride: visibilityProvenStale
  })
  // A genuine visibilitychange means the occlusion tracker is reporting
  // again — hand authority back to document.visibilityState.
  visibilityProvenStale = false
}

function installGlobalListeners(): void {
  if (
    globalListenersInstalled ||
    typeof document === 'undefined' ||
    typeof window === 'undefined' ||
    typeof document.addEventListener !== 'function'
  ) {
    return
  }
  globalListenersInstalled = true
  // Capture phase so no stopPropagation in the app can hide the proof; the
  // handler is a single property read when visibility is healthy.
  document.addEventListener('keydown', onUserInteractionWithDocument, {
    capture: true,
    passive: true
  })
  document.addEventListener('pointerdown', onUserInteractionWithDocument, {
    capture: true,
    passive: true
  })
  window.addEventListener('focus', onUserInteractionWithDocument)
  document.addEventListener('visibilitychange', onDocumentVisibilityChange)
}

function removeGlobalListeners(): void {
  if (!globalListenersInstalled) {
    return
  }
  globalListenersInstalled = false
  document.removeEventListener('keydown', onUserInteractionWithDocument, { capture: true })
  document.removeEventListener('pointerdown', onUserInteractionWithDocument, { capture: true })
  window.removeEventListener('focus', onUserInteractionWithDocument)
  document.removeEventListener('visibilitychange', onDocumentVisibilityChange)
}

// The listener runs when staleness is first proven; register the same handler
// used for document visibilitychange so recovery reuses the pane's existing
// gate-resync + hidden-output-restore path.
export function registerStaleDocumentVisibilityRecovery(
  listener: StaleVisibilityRecoveryListener
): () => void {
  installGlobalListeners()
  recoveryListeners.add(listener)
  return () => {
    recoveryListeners.delete(listener)
    if (recoveryListeners.size === 0) {
      removeGlobalListeners()
    }
  }
}

export function resetStaleDocumentVisibilityForTesting(): void {
  visibilityProvenStale = false
  recoveryListeners.clear()
  removeGlobalListeners()
}
