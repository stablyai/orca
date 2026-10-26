import { useEffect, useSyncExternalStore } from 'react'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { useAppStore } from '../store'
import { markNativeChatLaunchResumeDecided } from './native-chat-launch-resume-decision'
import {
  announceRestartResults,
  restartContinuationHistory,
  type RestartContinuationOutcome
} from './native-chat-restart-action-notifications'
import {
  allResumeSessionIds,
  type ResumeCandidate,
  type ResumeFailure
} from './native-chat-resume-on-restart-grouping'
import {
  beginResumeRun,
  resumeRunInFlight,
  resumeRunPendingIds,
  type ResumeRun,
  type ResumeRunStarter
} from './native-chat-resume-run'
import {
  forgetUnsentResumes,
  markUnsentResumes,
  withUnsentResumes
} from './native-chat-resume-unsent-requests'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  requestNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'
import { createOfferedChatWatch } from './native-chat-resume-offered-chat-watch'
import { watchResumeRunStatus } from './native-chat-resume-run-status-watch'

/** Share the host’s durable offer across dialog/status bar; opening is read-only, while snooze and launch preference belong to this client. */

// This store owns this machine’s restart offer; structured launch resolution keeps that runtime local.
const LOCAL = { kind: 'local' } as const

export type NativeChatRestartOffer = Readonly<{
  candidates: readonly ResumeCandidate[]
  /** Acted-on offers whose agent did not carry on, as the host still records them. */
  failed: readonly ResumeFailure[]
  /** Timestamp the received list so row ages remain stable and renders need not read Date.now(). */
  listedAt: number
}>

const EMPTY: NativeChatRestartOffer = { candidates: [], failed: [], listedAt: 0 }
let offer: NativeChatRestartOffer = EMPTY
let launch: Promise<void> | undefined
/** Fence rereads against action replies so a racing list cannot preempt or undo the action’s authoritative result. */
let actionsBegun = 0
let actionsSettled = 0
/** Memory-only history: retires after viewing and closing its finished summary, or on replacement. */
let run: ResumeRun | null = null
let releaseRunStatus: (() => void) | undefined
let resuming: readonly string[] = resumeRunPendingIds(null)
const listeners = new Set<() => void>()
const LAUNCH_READ_RETRY_DELAYS_MS = [100, 250, 500] as const

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Replace snapshots only when publishing changes so external-store readers share stable references between notifications. */
function publish(next: NativeChatRestartOffer): void {
  offer = next
  offeredChatWatch.sync()
  emit()
}

/** Confirmed empty answers retire dialog requests unless showing a run; failed reads hide rows but keep the request. */
function publishAnswer(answer: NativeChatRestartOffer): void {
  const next = withUnsentResumes(answer)
  publish(next)
  if (next.candidates.length === 0 && next.failed.length === 0 && run === null) {
    consumeNativeChatResumeOnRestartDialogRequest()
  }
}

function setRun(next: ResumeRun | null): void {
  run = next
  const pending = resumeRunPendingIds(next)
  // Same ids, same array, so readers of `resuming` re-render only when it changes.
  resuming = pending.join('\0') === resuming.join('\0') ? resuming : pending
  emit()
}

// Refresh on offered-chat activity only outside actions; a racing reread must not undo the action’s reply.
const offeredChatWatch = createOfferedChatWatch({
  feed: () => getStructuredAgentSessionStatusFeed(LOCAL),
  offeredIds: () => new Set([...offer.candidates, ...offer.failed].map((entry) => entry.sessionId)),
  listedAt: () => offer.listedAt,
  refresh: () => {
    if (actionsBegun === actionsSettled) {
      const issued = actionsBegun
      void readNativeChatRestartOffer(() => actionsBegun === issued)
    }
  }
})

export function getNativeChatRestartOffer(): NativeChatRestartOffer {
  return offer
}

export function getNativeChatRestartResuming(): readonly string[] {
  return resuming
}

export function getNativeChatRestartRun(): ResumeRun | null {
  return run
}

/** A finished summary must be shown before closing can retire it. */
export function markFinishedNativeChatRestartRunShown(shown: ResumeRun): void {
  if (run === shown && !shown.inFlight && !shown.finishedViewShown) {
    setRun({ ...shown, finishedViewShown: true })
  }
}

export function releaseFinishedNativeChatRestartRun(): void {
  if (run?.finishedViewShown && !resumeRunInFlight(run)) {
    setRun(null)
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

type HostOfferRead = {
  candidates: readonly ResumeCandidate[]
  failed: readonly ResumeFailure[]
  available: boolean
}

/** Older hosts may omit failed; treat absence as an empty failure list. */
type HostOfferPayload = { sessions?: unknown; failed?: unknown }

function failedFrom(payload: HostOfferPayload): ResumeFailure[] {
  // SAFETY: the host is the single writer of this shape; a malformed row is a host bug, not input.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above.
  return Array.isArray(payload.failed) ? (payload.failed as ResumeFailure[]) : []
}

async function readNativeChatRestartOffer(current = () => true): Promise<HostOfferRead> {
  try {
    const offered = await callStructuredAgentSession<HostOfferPayload>(
      LOCAL,
      'agentSession.restartResumable'
    )
    if (!Array.isArray(offered.sessions)) {
      throw new Error('agent_session_restart_offer_invalid')
    }
    const failed = failedFrom(offered)
    if (current()) {
      publishAnswer({ candidates: offered.sessions, failed, listedAt: Date.now() })
    }
    return { candidates: offered.sessions, failed, available: true }
  } catch {
    // Hide unconfirmed rows on read failure without deleting durable offers; a later refresh may restore them.
    if (current()) {
      publish({ ...EMPTY, listedAt: Date.now() })
    }
    return { candidates: [], failed: [], available: false }
  }
}

export async function refreshNativeChatRestartOffer(): Promise<void> {
  await readNativeChatRestartOffer()
}

/** Reread before opening so the dialog exposes only current offers; opening a chat itself remains read-only. */
export async function reopenNativeChatRestartOffer(): Promise<void> {
  // Mid-resume the host's answer is already on its way; a re-read racing it could undo it.
  if (resuming.length === 0) {
    await readNativeChatRestartOffer()
  }
  if (run !== null || offer.candidates.length > 0 || offer.failed.length > 0) {
    requestNativeChatResumeOnRestartDialog()
  }
}

/** One host action owns the selection; its status feed reports each chat before the reply. */
export async function continueNativeChatRestartOffer(
  sessionIds: readonly string[],
  startedBy: ResumeRunStarter = 'user'
): Promise<void> {
  const requested = [...new Set(sessionIds)]
  if (requested.length === 0) {
    return
  }
  actionsBegun += 1
  forgetUnsentResumes(requested)
  const rows = new Map([...offer.candidates, ...offer.failed].map((row) => [row.sessionId, row]))
  let actionRun = beginResumeRun(
    requested.flatMap((sessionId) => rows.get(sessionId) ?? []),
    Date.now(),
    startedBy
  )
  setRun(actionRun)
  releaseRunStatus?.()
  const release = watchResumeRunStatus(
    () => (run === actionRun ? actionRun : null),
    (next) => {
      actionRun = next
      setRun(next)
    }
  )
  releaseRunStatus = release
  markNativeChatLaunchResumeDecided()
  let outcome: Parameters<typeof announceRestartResults>
  let continued: readonly RestartContinuationOutcome[] | undefined
  let skipped = new Set<string>()
  try {
    const result = await callStructuredAgentSession<
      HostOfferPayload & { continued?: RestartContinuationOutcome[]; skipped?: string[] }
    >(LOCAL, 'agentSession.restartContinue', { sessionIds: requested })
    const listed = Array.isArray(result.failed) ? failedFrom(result) : undefined
    if (Array.isArray(result.sessions)) {
      publishAnswer({ candidates: result.sessions, failed: listed ?? [], listedAt: Date.now() })
    } else {
      await refreshNativeChatRestartOffer()
    }
    skipped = new Set(result.skipped)
    const actedOn = requested.filter((sessionId) => !skipped.has(sessionId))
    continued = restartContinuationHistory(actedOn, result.continued, listed)
    outcome = [actedOn, continued, listed, reopenNativeChatRestartOffer]
  } catch (error) {
    console.warn('[native-chat-resume] resume request failed before reaching the chats', error)
    markUnsentResumes(requested, Date.now())
    const read = await readNativeChatRestartOffer()
    outcome = [
      requested,
      [],
      read.available ? offer.failed : undefined,
      reopenNativeChatRestartOffer
    ]
  } finally {
    release()
    if (releaseRunStatus === release) {
      releaseRunStatus = undefined
    }
    actionsSettled += 1
    // Publish the offer first: reopening must never expose the old selection as actionable.
    if (run === actionRun) {
      setRun({
        ...actionRun,
        entries: actionRun.entries.filter((entry) => !skipped.has(entry.candidate.sessionId)),
        inFlight: false,
        continued
      })
    }
  }
  announceRestartResults(...outcome)
}

/** Dismiss deletes durable offers only on host success; failed writes preserve records for a later reread or launch. */
export async function dismissNativeChatRestartOffer(sessionIds?: readonly string[]): Promise<void> {
  actionsBegun += 1
  try {
    const result = await callStructuredAgentSession<HostOfferPayload>(
      LOCAL,
      'agentSession.restartResumableDismiss',
      // Name failed rows explicitly, including locally lost requests the host still lists as offers.
      sessionIds ? { sessionIds: [...sessionIds] } : {}
    )
    // Only a dismissal the host took ends the mark; a failed one leaves the chat shown as failed.
    forgetUnsentResumes(sessionIds)
    if (Array.isArray(result.sessions)) {
      publishAnswer({
        candidates: result.sessions,
        failed: failedFrom(result),
        listedAt: Date.now()
      })
    } else {
      await refreshNativeChatRestartOffer()
    }
  } catch {
    await refreshNativeChatRestartOffer()
  } finally {
    actionsSettled += 1
  }
}

/** Read and decide once per launch; automatic resume uses the same action as Resume, while inspecting chats stays read-only. */
async function loadLaunchOffer(): Promise<void> {
  // The preference belongs to this launch's request; later saves cannot dispatch another.
  const autoResume = useAppStore.getState().settings?.nativeChatResumeWorkOnRestart === true
  let read = await readNativeChatRestartOffer()
  // Retry startup read failures only, never confirmed empty offers, without adding steady-state polling.
  for (const delay of LAUNCH_READ_RETRY_DELAYS_MS) {
    if (read.available) {
      break
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
    read = await readNativeChatRestartOffer()
  }
  const offered = read.candidates
  // Failures left from an earlier launch are the status bar's to show; only a fresh offer asks.
  if (offered.length === 0) {
    return
  }
  if (!autoResume) {
    requestNativeChatResumeOnRestartDialog()
    return
  }
  await continueNativeChatRestartOffer(allResumeSessionIds(offered), 'launch')
}

/** Load once when enabled; delayed settings must enable the initial read rather than lose it. */
export function useNativeChatRestartOffer(enabled: boolean): NativeChatRestartOffer {
  useEffect(() => {
    if (enabled) {
      // Fetched after mount, never awaited by startup: the workspace is usable first.
      launch ??= loadLaunchOffer().finally(markNativeChatLaunchResumeDecided)
    }
  }, [enabled])
  return useSyncExternalStore(subscribe, getNativeChatRestartOffer, getNativeChatRestartOffer)
}

export function useNativeChatRestartResuming(): readonly string[] {
  return useSyncExternalStore(subscribe, getNativeChatRestartResuming, getNativeChatRestartResuming)
}

export function useNativeChatRestartRun(): ResumeRun | null {
  return useSyncExternalStore(subscribe, getNativeChatRestartRun, getNativeChatRestartRun)
}

/** @internal - tests need a clean module between cases. */
export function _resetNativeChatRestartOffer(): void {
  releaseRunStatus?.()
  releaseRunStatus = undefined
  offeredChatWatch.release()
  offer = EMPTY
  forgetUnsentResumes(undefined)
  run = null
  resuming = resumeRunPendingIds(null)
  actionsBegun = 0
  actionsSettled = 0
  launch = undefined
  listeners.clear()
}
