import { setTerminalPrewarmWorktrees } from '../../../terminal/terminal-worktree-prewarm'
import {
  notePredictiveWakeHoverEnd,
  notePredictiveWakeHoverStart,
  notePredictiveWakeSelect
} from '@/lib/orca-cloud/cloud-predictive-wake'

// Long enough that sweeping or scrolling past rows never mounts them; short enough to finish before a typical press.
export const HOVER_PREWARM_DWELL_MS = 120
// Brief exits (e.g. toward a row action) must not drop the warm mount and pay it again.
export const HOVER_PREWARM_GRACE_MS = 1500

let dwellTimer: ReturnType<typeof setTimeout> | null = null
let dwellWorktreeId: string | null = null
let graceTimer: ReturnType<typeof setTimeout> | null = null
let prewarmedWorktreeId: string | null = null
let wheelListenerInstalled = false
// The row a predictive-wake dwell is armed for (outlives the shorter prewarm dwell).
let predictiveHoverId: string | null = null

function clearDwell(): void {
  if (dwellTimer !== null) {
    clearTimeout(dwellTimer)
  }
  dwellTimer = null
  dwellWorktreeId = null
}

function clearGrace(): void {
  if (graceTimer !== null) {
    clearTimeout(graceTimer)
  }
  graceTimer = null
}

function prewarm(worktreeId: string): void {
  clearDwell()
  clearGrace()
  prewarmedWorktreeId = worktreeId
  setTerminalPrewarmWorktrees('hover', [worktreeId])
}

function armDwell(worktreeId: string, delayMs = HOVER_PREWARM_DWELL_MS): void {
  clearDwell()
  dwellWorktreeId = worktreeId
  dwellTimer = setTimeout(() => prewarm(worktreeId), delayMs)
}

// Rows scrolling under a resting pointer fire pointerenter; restart the dwell so scrolling never prewarms.
function installWheelListener(): void {
  if (wheelListenerInstalled || typeof window === 'undefined') {
    return
  }
  wheelListenerInstalled = true
  window.addEventListener(
    'wheel',
    () => {
      if (dwellWorktreeId !== null) {
        armDwell(dwellWorktreeId)
      }
      // Scrolling under a resting pointer is not intent either: restart the wake dwell too.
      if (predictiveHoverId !== null) {
        notePredictiveWakeHoverStart(predictiveHoverId)
      }
    },
    { capture: true, passive: true }
  )
}

export function noteWorktreeRowHoverStart(worktreeId: string): void {
  // A sleeping cloud workspace starts waking on a longer dwell (no-op for everything else).
  predictiveHoverId = worktreeId
  notePredictiveWakeHoverStart(worktreeId)
  installWheelListener()
  if (prewarmedWorktreeId === worktreeId) {
    clearDwell()
    clearGrace()
    return
  }
  armDwell(worktreeId)
}

/** A press is intent enough to skip the hover dwell; the mount still waits a task so it can't delay the press's focus move or drag start. */
export function noteWorktreeRowPress(worktreeId: string): void {
  notePredictiveWakeSelect(worktreeId)
  if (prewarmedWorktreeId !== worktreeId) {
    armDwell(worktreeId, 0)
  }
}

export function noteWorktreeRowHoverEnd(worktreeId: string): void {
  if (predictiveHoverId === worktreeId) {
    predictiveHoverId = null
  }
  notePredictiveWakeHoverEnd(worktreeId)
  if (dwellWorktreeId === worktreeId) {
    clearDwell()
  }
  if (prewarmedWorktreeId !== worktreeId || graceTimer !== null) {
    return
  }
  graceTimer = setTimeout(() => {
    graceTimer = null
    prewarmedWorktreeId = null
    setTerminalPrewarmWorktrees('hover', [])
  }, HOVER_PREWARM_GRACE_MS)
}
