import { resetAllTerminalWebglAtlases } from '@/lib/pane-manager/pane-manager-registry'

const IMAGE_PASTE_ATLAS_RECOVERY_DELAYS_MS = [120, 500]

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

export function scheduleImagePasteWebglAtlasRecovery(): void {
  // Why: Claude Code redraws its image chip immediately after bracketed paste,
  // and xterm WebGL atlas corruption can appear after that redraw without a
  // context-loss event. A few cheap resets cover the post-paste paint window.
  scheduleNextFrame(() => resetAtlases())
  for (const delayMs of IMAGE_PASTE_ATLAS_RECOVERY_DELAYS_MS) {
    globalThis.setTimeout(() => resetAtlases(), delayMs)
  }
}
