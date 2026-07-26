import { resetAndRefreshAllTerminalWebglAtlases } from '@/lib/pane-manager/pane-manager-registry'

const ATLAS_RECOVERY_DELAYS_MS = [120, 500]

// Why: a streaming TUI requests output atlas recovery every frame; recovering
// mid-stream clears the shared atlas and repaints every pane, which flickers
// (STA-1365). Wait for output to go quiet so recovery runs once, on settle.
export const TERMINAL_OUTPUT_RECOVERY_QUIET_MS = 200

let terminalOutputRecoveryDebounceTimer: ReturnType<typeof setTimeout> | null = null

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

export function scheduleImagePasteWebglAtlasRecovery(): void {
  // Why: image chips can redraw after bracketed paste parsing, so cover the
  // short post-paste paint window with a few cheap atlas rebuilds. Paste is a
  // one-shot event, so recover immediately rather than debouncing.
  scheduleAtlasRecoveryBurst()
}

export function scheduleTabRevealWebglAtlasRecovery(): void {
  // Why: a tab reveal is one-shot, so recover immediately — decoupled from the
  // streaming debounce so a background stream can't defer a revealed tab's rebuild.
  scheduleAtlasRecoveryBurst()
}

export function scheduleTerminalWebglAtlasRecovery(): void {
  // Why: terminal-output recovery (foreground + hidden PTY writes). Trailing-edge
  // debounce so a clear only ever runs after 200ms of quiet — never mid-stream;
  // a resumed stream cancels the pending timer, so a pause-then-resume can't leak.
  if (terminalOutputRecoveryDebounceTimer != null) {
    globalThis.clearTimeout(terminalOutputRecoveryDebounceTimer)
  }
  terminalOutputRecoveryDebounceTimer = globalThis.setTimeout(() => {
    terminalOutputRecoveryDebounceTimer = null
    resetAtlasesAndRefreshPanes()
  }, TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
}
