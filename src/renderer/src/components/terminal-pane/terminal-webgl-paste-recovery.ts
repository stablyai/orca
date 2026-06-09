type TerminalWebglRecoveryManager = {
  resetWebglTextureAtlases: () => void
}

const IMAGE_PASTE_ATLAS_RECOVERY_DELAYS_MS = [120, 500]

function scheduleNextFrame(callback: () => void): void {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(callback)
    return
  }
  globalThis.setTimeout(callback, 0)
}

function resetAtlas(manager: TerminalWebglRecoveryManager): void {
  try {
    manager.resetWebglTextureAtlases()
  } catch {
    /* ignore - terminal pane may have unmounted after paste */
  }
}

export function scheduleImagePasteWebglAtlasRecovery(manager: TerminalWebglRecoveryManager): void {
  // Why: Claude Code redraws its image chip immediately after bracketed paste,
  // and xterm WebGL atlas corruption can appear after that redraw without a
  // context-loss event. A few cheap resets cover the post-paste paint window.
  scheduleNextFrame(() => resetAtlas(manager))
  for (const delayMs of IMAGE_PASTE_ATLAS_RECOVERY_DELAYS_MS) {
    globalThis.setTimeout(() => resetAtlas(manager), delayMs)
  }
}
