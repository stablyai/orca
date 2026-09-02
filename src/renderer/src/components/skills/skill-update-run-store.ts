import { useSyncExternalStore } from 'react'
import type { SkillUpdateRun } from '../../../../shared/skill-freshness'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import {
  getSkillFreshnessUpdateDialogRequest,
  subscribeSkillFreshnessUpdateDialog
} from './skill-freshness-update-dialog'

// Why: the run outlives the dialog — closing the window must not cancel it, and
// the status-bar segment needs the same snapshot. Keeping it outside React means
// neither surface owns the lifecycle.
let run: SkillUpdateRun = { state: 'idle' }
const listeners = new Set<() => void>()
let subscribed = false
let successTimer: ReturnType<typeof setTimeout> | null = null

/** How long a finished run keeps its green check in the status bar. */
export const SKILL_UPDATE_SUCCESS_LINGER_MS = 4000

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function clearSuccessTimer(): void {
  if (successTimer) {
    clearTimeout(successTimer)
    successTimer = null
  }
}

/**
 * Why: a success needs to be *seen*, then get out of the way. Errors stay until
 * the user acts on them. The dialog renders this same run, so retiring it while
 * the dialog is open would yank the result rows out from under someone reading
 * them — there, closing the dialog is what acknowledges the run.
 */
function scheduleSuccessLinger(): void {
  clearSuccessTimer()
  if (run.state !== 'success' || getSkillFreshnessUpdateDialogRequest()) {
    return
  }
  successTimer = setTimeout(() => {
    successTimer = null
    void acknowledgeSkillUpdateRun()
  }, SKILL_UPDATE_SUCCESS_LINGER_MS)
}

// Opening the dialog on a lingering success hands ownership back to it.
subscribeSkillFreshnessUpdateDialog(scheduleSuccessLinger)

function setRun(next: SkillUpdateRun): void {
  const wasRunning = run.state === 'running'
  run = next
  scheduleSuccessLinger()
  // A run that stopped changes what's on disk — including a cancelled one, which
  // may have written several skills before the kill landed. Without this a Stop
  // leaves the rows and the count describing the pre-run scan, so the Update
  // button re-offers skills that already updated.
  if (next.state === 'success' || next.state === 'error' || (wasRunning && next.state === 'idle')) {
    notifyInstalledAgentSkillsChanged()
  }
  emit()
}

function ensureSubscribed(): void {
  if (subscribed) {
    return
  }
  subscribed = true
  window.api.skills.onUpdateRun(setRun)
  void window.api.skills.getUpdateRun().then((current) => {
    // Don't clobber a live push that landed while this promise was in flight.
    if (run.state === 'idle') {
      setRun(current)
    }
  })
}

export function subscribeSkillUpdateRun(listener: () => void): () => void {
  ensureSubscribed()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSkillUpdateRun(): SkillUpdateRun {
  return run
}

export function useSkillUpdateRun(): SkillUpdateRun {
  return useSyncExternalStore(subscribeSkillUpdateRun, getSkillUpdateRun, getSkillUpdateRun)
}

// Why: every caller fires these from an event handler with `void`. Swallowing
// here rather than at each call site keeps a dropped IPC from surfacing as an
// unhandled rejection; the run state itself is pushed from main either way.
export async function startSkillUpdateRun(names: readonly string[]): Promise<void> {
  ensureSubscribed()
  try {
    await window.api.skills.startUpdateRun([...names])
  } catch (error) {
    console.error('Failed to start skill update run', error)
  }
}

export async function cancelSkillUpdateRun(): Promise<void> {
  try {
    await window.api.skills.cancelUpdateRun()
  } catch (error) {
    console.error('Failed to cancel skill update run', error)
  }
}

export async function acknowledgeSkillUpdateRun(): Promise<void> {
  try {
    await window.api.skills.acknowledgeUpdateRun()
  } catch (error) {
    console.error('Failed to acknowledge skill update run', error)
  }
}

/** @internal - tests need a clean module between cases. */
export function _resetSkillUpdateRunStore(): void {
  run = { state: 'idle' }
  subscribed = false
  clearSuccessTimer()
  listeners.clear()
}
