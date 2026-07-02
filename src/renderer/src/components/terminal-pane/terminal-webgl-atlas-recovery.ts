import { resetAndRefreshAllTerminalWebglAtlases } from '@/lib/pane-manager/pane-manager-registry'
import { e2eConfig } from '@/lib/e2e-config'

const ATLAS_RECOVERY_DELAYS_MS = [120, 500]

let terminalOutputRecoveryScheduled = false
let terminalVisibilityFrameRecoveryScheduled = false
let terminalVisibilityDelayedRecoveryScheduled = false

type TerminalRecoveryTestWindow = Window & {
  __terminalTabOverlapSuppressVisibilityRecovery?: boolean
}

function isVisibilityRecoverySuppressedForTest(): boolean {
  return (
    e2eConfig.exposeStore &&
    typeof window !== 'undefined' &&
    Boolean((window as TerminalRecoveryTestWindow).__terminalTabOverlapSuppressVisibilityRecovery)
  )
}

function scheduleNextFrame(callback: () => void): void {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(callback)
    return
  }
  globalThis.setTimeout(callback, 0)
}

function resetAtlasesAndRefreshPanes(): void {
  try {
    // Why: the glyph atlas is shared across same-config terminals, so the
    // recovery reset must be followed by repainting each rebuilt render model.
    resetAndRefreshAllTerminalWebglAtlases()
  } catch {
    /* ignore - terminal pane may have unmounted after scheduling recovery */
  }
}

type AtlasRecoveryBurstCallbacks = {
  onComplete?: () => void
  onFirstReset?: () => void
}

function scheduleAtlasRecoveryBurst(callbacks: AtlasRecoveryBurstCallbacks = {}): void {
  scheduleNextFrame(() => {
    resetAtlasesAndRefreshPanes()
    callbacks.onFirstReset?.()
  })
  for (const [index, delayMs] of ATLAS_RECOVERY_DELAYS_MS.entries()) {
    globalThis.setTimeout(() => {
      resetAtlasesAndRefreshPanes()
      if (index === ATLAS_RECOVERY_DELAYS_MS.length - 1) {
        callbacks.onComplete?.()
      }
    }, delayMs)
  }
}

export function scheduleImagePasteWebglAtlasRecovery(): void {
  // Why: image chips can redraw after bracketed paste parsing, so cover the
  // short post-paste paint window with a few cheap atlas rebuilds.
  scheduleAtlasRecoveryBurst()
}

export function scheduleTerminalWebglAtlasRecovery(): void {
  if (terminalOutputRecoveryScheduled) {
    return
  }
  terminalOutputRecoveryScheduled = true
  // Why: TUI redraw bursts can corrupt xterm's shared WebGL glyph atlas without
  // a context-loss event; coalesce resets so output storms do not queue timers.
  scheduleAtlasRecoveryBurst({
    onComplete: () => {
      terminalOutputRecoveryScheduled = false
    }
  })
}

export function scheduleTerminalVisibilityWebglRecovery(): void {
  if (isVisibilityRecoverySuppressedForTest()) {
    return
  }
  if (terminalVisibilityFrameRecoveryScheduled) {
    return
  }
  terminalVisibilityFrameRecoveryScheduled = true
  // Why: tab reveal is a separate repaint boundary from hidden-output parsing,
  // so an in-flight output recovery must not suppress the returned tab's repaint.
  // The first-frame repaint is per reveal, while the delayed tail is coalesced
  // so rapid tab cycling does not queue unbounded global refresh bursts.
  scheduleNextFrame(() => {
    resetAtlasesAndRefreshPanes()
    terminalVisibilityFrameRecoveryScheduled = false
  })
  if (terminalVisibilityDelayedRecoveryScheduled) {
    return
  }
  terminalVisibilityDelayedRecoveryScheduled = true
  for (const [index, delayMs] of ATLAS_RECOVERY_DELAYS_MS.entries()) {
    globalThis.setTimeout(() => {
      resetAtlasesAndRefreshPanes()
      if (index === ATLAS_RECOVERY_DELAYS_MS.length - 1) {
        terminalVisibilityDelayedRecoveryScheduled = false
      }
    }, delayMs)
  }
}
