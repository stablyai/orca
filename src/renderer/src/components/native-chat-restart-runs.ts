import { useSyncExternalStore } from 'react'
import type { RestartContinuationOutcome } from './native-chat-restart-action-notifications'
import { restartMachineTarget, type RestartMachineKey } from './native-chat-restart-machines'
import type { NativeChatRestartMachineOffer } from './native-chat-resume-on-restart-store'
import {
  beginResumeRun,
  resumeRunInFlight,
  resumeRunPendingIds,
  type ResumeRun
} from './native-chat-resume-run'
import { watchResumeRunStatus } from './native-chat-resume-run-status-watch'

/**
 * Each machine's latest resume, which the dialog and the status bar follow: the chats it named, each
 * one's live progress from that machine's host, then what became of each.
 *
 * Memory-only history. It retires after its finished summary was shown and then closed, when the
 * next resume starts (one resume's runs are followed together, as one run was before machines), or
 * when the machine is unpaired.
 */
export type NativeChatRestartRun = Readonly<{
  /** The listing the resume started from; it still names the machine once nothing is left there. */
  listing: NativeChatRestartMachineOffer
  run: ResumeRun
}>

export type NativeChatRestartRuns = ReadonlyMap<RestartMachineKey, NativeChatRestartRun>

const NO_RUNS: NativeChatRestartRuns = new Map()
const NOTHING_RESUMING: ReadonlyMap<RestartMachineKey, readonly string[]> = new Map()
let runs = NO_RUNS
let resuming = NOTHING_RESUMING
const statusWatches = new Map<RestartMachineKey, () => void>()
const listeners = new Set<() => void>()

function sameResuming(
  left: ReadonlyMap<RestartMachineKey, readonly string[]>,
  right: ReadonlyMap<RestartMachineKey, readonly string[]>
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([machine, ids]) => right.get(machine)?.join('\0') === ids.join('\0'))
  )
}

function setRun(machine: RestartMachineKey, next: NativeChatRestartRun | null): void {
  const updated = new Map(runs)
  if (next) {
    updated.set(machine, next)
  } else {
    updated.delete(machine)
  }
  runs = updated.size === 0 ? NO_RUNS : updated
  const pending = new Map<RestartMachineKey, readonly string[]>()
  for (const [key, entry] of runs) {
    const ids = resumeRunPendingIds(entry.run)
    if (ids.length > 0) {
      pending.set(key, ids)
    }
  }
  // Same chats, same map, so readers of `resuming` re-render only when it changes.
  if (!sameResuming(pending, resuming)) {
    resuming = pending.size === 0 ? NOTHING_RESUMING : pending
  }
  for (const listener of listeners) {
    listener()
  }
}

function releaseStatusWatch(machine: RestartMachineKey): void {
  statusWatches.get(machine)?.()
  statusWatches.delete(machine)
}

export type RestartRunAnswer = {
  continued?: readonly RestartContinuationOutcome[]
  /** Named chats the host left out of this action, e.g. another action already resuming them. */
  skipped?: ReadonlySet<string>
}

/**
 * Starts following one resume on the listing's machine, replacing that machine's last run and any
 * finished run of an earlier resume. The returned `finish` is called once the host's answer is
 * published, so reopening never shows the old selection as actionable.
 */
export function beginNativeChatRestartRun(
  listing: NativeChatRestartMachineOffer,
  sessionIds: readonly string[]
): (answer?: RestartRunAnswer) => void {
  const { machine } = listing
  const rows = new Map(
    [...listing.candidates, ...listing.failed].map((row) => [row.sessionId, row])
  )
  let current: NativeChatRestartRun = {
    listing,
    run: beginResumeRun(
      [...new Set(sessionIds)].flatMap((sessionId) => rows.get(sessionId) ?? []),
      Date.now()
    )
  }
  releaseStatusWatch(machine)
  for (const [other, entry] of runs) {
    if (other !== machine && !resumeRunInFlight(entry.run)) {
      setRun(other, null)
    }
  }
  setRun(machine, current)
  const release = watchResumeRunStatus(
    restartMachineTarget(machine),
    () => (runs.get(machine) === current ? current.run : null),
    (run) => {
      current = { ...current, run }
      setRun(machine, current)
    }
  )
  statusWatches.set(machine, release)
  return (answer = {}) => {
    release()
    if (statusWatches.get(machine) === release) {
      statusWatches.delete(machine)
    }
    if (runs.get(machine) !== current) {
      return
    }
    const skipped = answer.skipped ?? new Set<string>()
    current = {
      ...current,
      run: {
        ...current.run,
        entries: current.run.entries.filter((entry) => !skipped.has(entry.candidate.sessionId)),
        inFlight: false,
        continued: answer.continued
      }
    }
    setRun(machine, current)
  }
}

/** A finished summary must be shown before closing can retire it. */
export function markFinishedNativeChatRestartRunsShown(shown: NativeChatRestartRuns): void {
  for (const [machine, entry] of shown) {
    if (runs.get(machine) === entry && !entry.run.inFlight && !entry.run.finishedViewShown) {
      setRun(machine, { ...entry, run: { ...entry.run, finishedViewShown: true } })
    }
  }
}

/** Closing the dialog retires every finished run it showed. */
export function releaseFinishedNativeChatRestartRuns(): void {
  for (const [machine, entry] of runs) {
    if (entry.run.finishedViewShown && !resumeRunInFlight(entry.run)) {
      setRun(machine, null)
    }
  }
}

/** An unpaired machine's run is not this desktop's to show. */
export function forgetNativeChatRestartRun(machine: RestartMachineKey): void {
  releaseStatusWatch(machine)
  if (runs.has(machine)) {
    setRun(machine, null)
  }
}

export function getNativeChatRestartRuns(): NativeChatRestartRuns {
  return runs
}

/** The chats each machine's resume is carrying on right now, until the host answers. */
export function getNativeChatRestartResuming(): ReadonlyMap<RestartMachineKey, readonly string[]> {
  return resuming
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useNativeChatRestartRuns(): NativeChatRestartRuns {
  return useSyncExternalStore(subscribe, getNativeChatRestartRuns, getNativeChatRestartRuns)
}

/** The chats a resume is carrying on right now, per machine, whichever surface started it. */
export function useNativeChatRestartResuming(): ReadonlyMap<RestartMachineKey, readonly string[]> {
  return useSyncExternalStore(subscribe, getNativeChatRestartResuming, getNativeChatRestartResuming)
}

/** @internal - tests need a clean module between cases. */
export function _resetNativeChatRestartRuns(): void {
  for (const machine of statusWatches.keys()) {
    releaseStatusWatch(machine)
  }
  runs = NO_RUNS
  resuming = NOTHING_RESUMING
  listeners.clear()
}
