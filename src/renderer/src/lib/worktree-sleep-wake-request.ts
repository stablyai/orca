import { useSyncExternalStore } from 'react'
import type { CloudWakeProgressEvent } from '../../../shared/hosted-sandbox/cloud-workspace-api'
import { beginWorkspaceWake } from '@/components/terminal-pane/input/wake-input-buffer'

// "Wake to continue" pressed while main is still suspending the VM (past its last reopen check):
// the VM goes down first and only then can it wake. From the press until main's own wake reports,
// the workspace shows as waking, counted from the press, never as dead panes with no cover.
type WakeRequest = {
  /** Epoch ms of the press: the wake's start, for the pill and for main's later reports. */
  pressedAt: number
  /** When the sleep ended: main's wake reports from then on; stale counts from here. */
  sleepEndedAt: number | null
}

const requests = new Map<string, WakeRequest>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of Array.from(listeners)) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function requestWakeAfterSleep(worktreeId: string, pressedAt: number): void {
  if (!requests.has(worktreeId)) {
    requests.set(worktreeId, { pressedAt, sleepEndedAt: null })
    emit()
  }
  // Typing from the press on is held and delivered to the woken terminal.
  beginWorkspaceWake(worktreeId, pressedAt)
}

export function hasWakeAfterSleepRequest(worktreeId: string): boolean {
  return requests.has(worktreeId)
}

/** The sleep ended: from now on the wake must start reporting, or it shows as stalled. */
export function noteWakeAfterSleepSleepEnded(worktreeId: string, at: number): void {
  const request = requests.get(worktreeId)
  if (request && request.sleepEndedAt === null) {
    requests.set(worktreeId, { ...request, sleepEndedAt: at })
    emit()
  }
}

export function clearWakeAfterSleepRequest(worktreeId: string): void {
  if (requests.delete(worktreeId)) {
    emit()
  }
}

/**
 * Main's reports for the wake the press asked for count from the press. Only reports of a wake
 * that began at or after the press are taken: an older one is not this wake.
 */
export function wakeAfterSleepStartedAt(worktreeId: string, startedAt: number): number {
  const request = requests.get(worktreeId)
  return request && startedAt >= request.pressedAt ? request.pressedAt : startedAt
}

/** The wake shown until main reports its own (same start, so the pill never jumps). */
export function useWakeAfterSleep(worktreeId: string): CloudWakeProgressEvent | undefined {
  const request = useSyncExternalStore(subscribe, () => requests.get(worktreeId))
  if (!request) {
    return undefined
  }
  return {
    workspaceId: worktreeId,
    phase: 'waking',
    source: 'open',
    startedAt: request.pressedAt,
    at: request.sleepEndedAt ?? request.pressedAt
  }
}

export function resetWakeAfterSleepForTests(): void {
  requests.clear()
  listeners.clear()
}
