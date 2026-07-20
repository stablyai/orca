import { resetAndRefreshAllTerminalWebglAtlases } from '@/lib/pane-manager/pane-manager-registry'

const ATLAS_RECOVERY_DELAYS_MS = [120, 500]
const TERMINAL_OUTPUT_RECOVERY_COOLDOWN_MS = 30_000

let terminalOutputRecoveryCoolingDown = false
let terminalOutputRecoveryPending = false

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

function scheduleAtlasRecoveryBurst(): void {
  scheduleNextFrame(() => resetAtlasesAndRefreshPanes())
  for (const delayMs of ATLAS_RECOVERY_DELAYS_MS) {
    globalThis.setTimeout(() => resetAtlasesAndRefreshPanes(), delayMs)
  }
}
export function scheduleTerminalWebglAtlasRecovery(): void {
  if (terminalOutputRecoveryCoolingDown) {
    terminalOutputRecoveryPending = true
    return
  }
  terminalOutputRecoveryCoolingDown = true
  terminalOutputRecoveryPending = false
  // Why: renderer-risk output can corrupt xterm's shared glyph atlas without a
  // context-loss event. Recover promptly, then coalesce throughput-coupled
  // requests into one trailing rebuild after the global cooldown.
  scheduleAtlasRecoveryBurst()
  globalThis.setTimeout(() => {
    terminalOutputRecoveryCoolingDown = false
    if (terminalOutputRecoveryPending) {
      scheduleTerminalWebglAtlasRecovery()
    }
  }, TERMINAL_OUTPUT_RECOVERY_COOLDOWN_MS)
}

export function scheduleImagePasteWebglAtlasRecovery(): void {
  // Why: image paste is a one-shot renderer lifecycle event, so its recovery
  // can rebuild the shared atlas without coupling cost to PTY throughput.
  scheduleAtlasRecoveryBurst()
}

export function scheduleTabRevealWebglAtlasRecovery(): void {
  // Why: tab reveal is also one-shot; repaint after layout without putting any
  // shared-atlas work on the routine terminal-output path.
  scheduleAtlasRecoveryBurst()
}
