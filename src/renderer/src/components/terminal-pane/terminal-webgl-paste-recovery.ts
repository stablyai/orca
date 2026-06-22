import { resetAllTerminalWebglAtlases } from '@/lib/pane-manager/pane-manager-registry'

const PASTE_ATLAS_RECOVERY_DELAYS_MS = [120, 500]

function scheduleNextFrame(callback: () => void): void {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(callback)
    return
  }
  globalThis.setTimeout(callback, 0)
}

function resetAtlases(): void {
  try {
    // Why: the glyph atlas is shared across same-config terminals, so the
    // recovery reset must rebuild every live terminal's render model — a
    // single-manager reset would garble the others.
    resetAllTerminalWebglAtlases()
  } catch {
    /* ignore - terminal pane may have unmounted after paste */
  }
}

export function schedulePasteWebglAtlasRecovery(): void {
  // Why: a TUI (e.g. Claude Code) redraws immediately after a bracketed paste —
  // an image chip, or a pasted URL/text — and xterm WebGL atlas corruption can
  // appear after that redraw without a context-loss event. A few cheap resets
  // cover the post-paste paint window.
  scheduleNextFrame(() => resetAtlases())
  for (const delayMs of PASTE_ATLAS_RECOVERY_DELAYS_MS) {
    globalThis.setTimeout(() => resetAtlases(), delayMs)
  }
}

// Recover the atlas only after bracketed pastes — those trigger the TUI redraw
// that can corrupt it (image paste, or a long text/URL paste, issue #5960).
// Direct (non-bracketed) pastes don't redraw enough to need it.
export function maybeScheduleWebglAtlasRecoveryForPaste(plan: { bracketed: boolean }): void {
  if (plan.bracketed) {
    schedulePasteWebglAtlasRecovery()
  }
}
