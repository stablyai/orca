// After macOS display sleep, Chromium can stay hidden without visibilitychange; real input overrides that stale state until the tracker changes again, preventing visible PTYs from losing delivery.

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
  // A genuine visibilitychange restores tracker authority.
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
  // Capture input before app stopPropagation can hide the visibility evidence.
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

// Reuse each pane’s visibilitychange recovery for gate resync and hidden-output restore.
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
