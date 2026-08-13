import {
  presentAllTerminalPanesWithoutAtlasClear,
  resetAndRefreshAllTerminalWebglAtlases
} from '@/lib/pane-manager/pane-manager-registry'

const ATLAS_RECOVERY_DELAYS_MS = [120, 500]

function scheduleNextFrame(callback: () => void): void {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(callback)
    return
  }
  globalThis.setTimeout(callback, 0)
}

function resetAtlasesAndRefreshPanes(reason: string): void {
  try {
    // Why: the glyph atlas is shared across same-config terminals, so the
    // recovery reset must be followed by repainting each rebuilt render model.
    resetAndRefreshAllTerminalWebglAtlases(reason)
  } catch {
    /* ignore - terminal pane may have unmounted after scheduling recovery */
  }
}

function presentPanesWithoutAtlasClear(reason: string): void {
  try {
    presentAllTerminalPanesWithoutAtlasClear(reason)
  } catch {
    /* ignore - terminal pane may have unmounted after scheduling recovery */
  }
}

/** Whether the delayed coverage shots re-wipe the shared atlas or just present. */
type AtlasRecoveryCoverage = 'reset' | 'present'

function scheduleAtlasRecoveryBurst(reason: string, coverage: AtlasRecoveryCoverage): void {
  scheduleNextFrame(() => resetAtlasesAndRefreshPanes(reason))
  const coverageShot =
    coverage === 'reset'
      ? () => resetAtlasesAndRefreshPanes(reason)
      : () => presentPanesWithoutAtlasClear(reason)
  for (const delayMs of ATLAS_RECOVERY_DELAYS_MS) {
    globalThis.setTimeout(coverageShot, delayMs)
  }
}

export function scheduleImagePasteWebglAtlasRecovery(): void {
  // Why: image chips can redraw after bracketed paste parsing, and that late
  // redraw can corrupt the shared glyph atlas with no context-loss event —
  // only clearTextureAtlas repairs it, and paste has no settled-reveal
  // follow-up, so every coverage shot keeps clearing (945b27045).
  scheduleAtlasRecoveryBurst('image-paste', 'reset')
}

export function scheduleTabRevealWebglAtlasRecovery(): void {
  // Why: a tab reveal is an explicit renderer lifecycle boundary where hidden
  // GPU state can be stale; ordinary PTY output must not clear the shared atlas.
  // The coverage shots only present: the first shot's clear already zeroed the
  // render model, and a second shared wipe re-arms xterm's page-merge garble
  // race (#4480) that the settled reveal repaint would then have to survive.
  scheduleAtlasRecoveryBurst('tab-reveal', 'present')
}
