import { resetAndRefreshAllTerminalWebglAtlases } from '@/lib/pane-manager/pane-manager-registry'

const ATLAS_RECOVERY_DELAYS_MS = [120, 500]
// Why: sustained CJK/TUI output (agent responses, spinner redraws over a CJK
// prompt line) can request recovery on nearly every chunk, and each burst
// re-rasterizes every visible glyph across all panes — felt as typing jank.
// Space bursts out with a cooldown instead of dropping requests, so the last
// risky chunk still gets a trailing recovery once the cooldown expires.
const ATLAS_RECOVERY_COOLDOWN_MS = 3000

type TerminalOutputRecoveryPhase = 'idle' | 'burst' | 'cooldown'
let terminalOutputRecoveryPhase: TerminalOutputRecoveryPhase = 'idle'
let terminalOutputRecoveryRequestedDuringCooldown = false
let terminalOutputRecoveryCooldownTimer: ReturnType<typeof setTimeout> | null = null

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

function startTerminalOutputRecoveryCooldown(): void {
  terminalOutputRecoveryPhase = 'cooldown'
  terminalOutputRecoveryCooldownTimer = globalThis.setTimeout(() => {
    terminalOutputRecoveryCooldownTimer = null
    if (terminalOutputRecoveryRequestedDuringCooldown) {
      terminalOutputRecoveryRequestedDuringCooldown = false
      terminalOutputRecoveryPhase = 'burst'
      scheduleAtlasRecoveryBurst(startTerminalOutputRecoveryCooldown)
      return
    }
    terminalOutputRecoveryPhase = 'idle'
  }, ATLAS_RECOVERY_COOLDOWN_MS)
}

export function scheduleImagePasteWebglAtlasRecovery(): void {
  // Why: image chips can redraw after bracketed paste parsing, so cover the
  // short post-paste paint window with a few cheap atlas rebuilds.
  scheduleAtlasRecoveryBurst()
}

export function scheduleTerminalRevealWebglAtlasRecovery(): void {
  // Why: tab reveal is a discrete user action whose repaint must not wait out
  // an output-driven recovery cooldown — a just-revealed pane showing stale
  // pixels for seconds reads as a rendering bug.
  scheduleAtlasRecoveryBurst()
}

export function scheduleTerminalWebglAtlasRecovery(): void {
  // Why: TUI redraw bursts can corrupt xterm's shared WebGL glyph atlas without
  // a context-loss event; coalesce resets so output storms do not queue timers.
  if (terminalOutputRecoveryPhase === 'burst') {
    // The in-flight burst's remaining resets already repaint this chunk.
    return
  }
  if (terminalOutputRecoveryPhase === 'cooldown') {
    terminalOutputRecoveryRequestedDuringCooldown = true
    return
  }
  terminalOutputRecoveryPhase = 'burst'
  scheduleAtlasRecoveryBurst(startTerminalOutputRecoveryCooldown)
}

export function _resetTerminalWebglAtlasRecoveryForTests(): void {
  if (terminalOutputRecoveryCooldownTimer !== null) {
    clearTimeout(terminalOutputRecoveryCooldownTimer)
    terminalOutputRecoveryCooldownTimer = null
  }
  terminalOutputRecoveryPhase = 'idle'
  terminalOutputRecoveryRequestedDuringCooldown = false
}
