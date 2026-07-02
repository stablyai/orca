import { resetAndRefreshAllTerminalWebglAtlases } from '@/lib/pane-manager/pane-manager-registry'

const ATLAS_RECOVERY_DELAYS_MS = [120, 500]

let terminalOutputRecoveryScheduled = false

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

function scheduleAtlasRecoveryBurst(onComplete?: () => void): void {
  scheduleNextFrame(() => resetAtlasesAndRefreshPanes())
  for (const [index, delayMs] of ATLAS_RECOVERY_DELAYS_MS.entries()) {
    globalThis.setTimeout(() => {
      resetAtlasesAndRefreshPanes()
      if (index === ATLAS_RECOVERY_DELAYS_MS.length - 1) {
        onComplete?.()
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
  scheduleAtlasRecoveryBurst(() => {
    terminalOutputRecoveryScheduled = false
  })
}
