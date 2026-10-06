import { useEffect, useSyncExternalStore } from 'react'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import {
  getStructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusFeedOwner
} from '@/runtime/structured-agent-session-status-feed'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { useAppStore } from '../store'
import {
  announceRestartResults,
  type RestartContinuationOutcome
} from './native-chat-restart-action-notifications'
import {
  allResumeSessionIds,
  type ResumeCandidate,
  type ResumeFailure
} from './native-chat-resume-on-restart-grouping'
import {
  forgetUnsentResumes,
  markUnsentResumes,
  withUnsentResumes
} from './native-chat-resume-unsent-requests'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  requestNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'

/**
 * Which interrupted chats the host is still offering to resume, and every action that moves that.
 *
 * The offer is the HOST's answer, shared by the dialog and the status bar rather than held by
 * whichever rendered first. Opening a chat is intentionally read-only; only an explicit action
 * changes the durable offer.
 *
 * What stays on this side is the user's own facts: the snooze, and the preference that decides
 * whether the launch asks at all.
 */

// Structured sessions run on the machine hosting the runtime; both launch resolvers refuse anything
// else, so there is no remote target to aim this at.
const LOCAL = { kind: 'local' } as const

export type NativeChatRestartOffer = Readonly<{
  candidates: readonly ResumeCandidate[]
  /** Acted-on offers whose agent did not carry on, as the host still records them. */
  failed: readonly ResumeFailure[]
  /** Stamped when the list arrived. Row ages read against this rather than a render-time
   *  `Date.now()`, so they stay stable across re-renders and the render stays pure. */
  listedAt: number
}>

const EMPTY: NativeChatRestartOffer = { candidates: [], failed: [], listedAt: 0 }
let offer: NativeChatRestartOffer = EMPTY
let launch: Promise<void> | undefined
/** Continue and dismiss calls, begun and settled. Each ends by publishing the host's answer, which
 *  a re-read that raced it must neither pre-empt nor undo. */
let actionsBegun = 0
let actionsSettled = 0
/** The chats each in-flight continue call names, so the status bar can report the resume after
 *  the dialog that started it has closed. Held only for the call's lifetime; never persisted. */
const resumeBatches = new Set<readonly string[]>()
const NOTHING_RESUMING: readonly string[] = []
let resuming: readonly string[] = NOTHING_RESUMING
const listeners = new Set<() => void>()
const LAUNCH_READ_RETRY_DELAYS_MS = [100, 250, 500] as const

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** The snapshot object is replaced HERE and nowhere else — never during a render — so every
 *  `useSyncExternalStore` reader sees the same reference until a host answer or a user action
 *  actually moves the offer. */
function publish(next: NativeChatRestartOffer): void {
  offer = next
  syncOfferedChatWatch()
  emit()
}

/** A confirmed host answer. One with nothing left also retires any open request for the dialog,
 *  which has nothing to show; a failed read only hides rows, so it keeps the request. */
function publishAnswer(answer: NativeChatRestartOffer): void {
  const next = withUnsentResumes(answer)
  publish(next)
  if (next.candidates.length === 0 && next.failed.length === 0) {
    consumeNativeChatResumeOnRestartDialogRequest()
  }
}

function syncResuming(): void {
  resuming = resumeBatches.size === 0 ? NOTHING_RESUMING : [...new Set([...resumeBatches].flat())]
  emit()
}

/**
 * Re-reads the host once an offered or failed chat shows new activity, so a message the user sent
 * there, or its agent starting, retires its entry here too. The host stays the judge; this only
 * asks again.
 *
 * Held only while something is offered or failed. Keyed on status and prompt rather than every
 * summary, so an agent streaming in such a chat costs one re-read, not one per tool call.
 */
const OFFERED_CHAT_REFRESH_DELAY_MS = 500
let offeredChatWatch: {
  feed: StructuredAgentSessionStatusFeedOwner
  seen: Map<string, string>
  release: () => void
} | null = null
let offeredChatRefresh: ReturnType<typeof setTimeout> | null = null

function offeredChatIds(): Set<string> {
  return new Set([...offer.candidates, ...offer.failed].map((entry) => entry.sessionId))
}

function offeredChatActivityKey(summary: AgentSessionStatusSummary): string {
  return `${summary.status ?? ''}\u0000${summary.latestPrompt}`
}

function syncOfferedChatWatch(): void {
  const offeredIds = offeredChatIds()
  if (offeredIds.size === 0) {
    releaseOfferedChatWatch()
    return
  }
  if (!offeredChatWatch) {
    const feed = getStructuredAgentSessionStatusFeed(LOCAL)
    const unsubscribe = feed.subscribe(noticeOfferedChatActivity)
    const deactivate = feed.activate()
    offeredChatWatch = {
      feed,
      seen: new Map(),
      release: () => {
        unsubscribe()
        deactivate()
      }
    }
  }
  const { feed, seen } = offeredChatWatch
  for (const sessionId of seen.keys()) {
    if (!offeredIds.has(sessionId)) {
      seen.delete(sessionId)
    }
  }
  // What the feed already holds is what this listing answered.
  for (const sessionId of offeredIds) {
    const summary = feed.getSnapshot().get(sessionId)
    if (summary && !seen.has(sessionId)) {
      seen.set(sessionId, offeredChatActivityKey(summary))
    }
  }
}

function noticeOfferedChatActivity(): void {
  if (!offeredChatWatch) {
    return
  }
  const { feed, seen } = offeredChatWatch
  const snapshot = feed.getSnapshot()
  let changed = false
  for (const sessionId of offeredChatIds()) {
    const summary = snapshot.get(sessionId)
    if (!summary) {
      continue
    }
    const key = offeredChatActivityKey(summary)
    const previous = seen.get(sessionId)
    if (previous !== key) {
      seen.set(sessionId, key)
      // A first sighting is news only if newer than the list; a change to a known chat always is,
      // since the host may have answered the list just before the change was delivered here.
      changed ||= previous !== undefined || summary.updatedAt > offer.listedAt
    }
  }
  if (changed && offeredChatRefresh === null) {
    offeredChatRefresh = setTimeout(() => {
      offeredChatRefresh = null
      if (actionsBegun === actionsSettled) {
        const issued = actionsBegun
        void readNativeChatRestartOffer(() => actionsBegun === issued)
      }
    }, OFFERED_CHAT_REFRESH_DELAY_MS)
  }
}

function releaseOfferedChatWatch(): void {
  if (offeredChatRefresh !== null) {
    clearTimeout(offeredChatRefresh)
    offeredChatRefresh = null
  }
  offeredChatWatch?.release()
  offeredChatWatch = null
}

export function getNativeChatRestartOffer(): NativeChatRestartOffer {
  return offer
}

export function getNativeChatRestartResuming(): readonly string[] {
  return resuming
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Re-reads the host's answer.
 *
 * Called before the dialog is reopened, so a count can never name a chat the host would now refuse.
 */
type HostOfferRead = {
  candidates: readonly ResumeCandidate[]
  failed: readonly ResumeFailure[]
  available: boolean
}

/** The host's answer as this side understands it. `failed` is optional on the wire: an older host
 *  never sends it, and its absence means nothing to show, not an invalid answer. */
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
    // A failed read is not an answer. Hide the last snapshot so a modal can never present a
    // candidate the host has not confirmed; the durable record remains and a later refresh can
    // restore it.
    if (current()) {
      publish({ ...EMPTY, listedAt: Date.now() })
    }
    return { candidates: [], failed: [], available: false }
  }
}

export async function refreshNativeChatRestartOffer(): Promise<void> {
  await readNativeChatRestartOffer()
}

/** The status bar entry and a toast's Show: re-read, then open only over rows, since the dialog
 *  draws nothing without them. Opening a chat from it is read-only and keeps the offer. */
export async function reopenNativeChatRestartOffer(): Promise<void> {
  // Mid-resume the host's answer is already on its way; a re-read racing it could undo it.
  if (resuming.length === 0) {
    await readNativeChatRestartOffer()
  }
  if (resuming.length > 0 || offer.candidates.length > 0 || offer.failed.length > 0) {
    requestNativeChatResumeOnRestartDialog()
  }
}

/**
 * Reattach the offered chats, ask each agent to carry on, then replace the offer with the host's
 * authoritative remaining list. This keeps the modal and status bar synchronized after every
 * action, even when the dialog's snapshot became stale while it was open.
 *
 * `sessionIds` is the dialog's selection. An opted-in launch names nothing, so the host acts on
 * whatever it still offers rather than on a list this side captured a moment earlier, and passes
 * `reported` instead: the chats the status bar shows as resuming.
 *
 * Ends in one toast saying what it did across those chats, whether a click or an opted-in launch
 * started it; each chat's note stays the record. Never rejects; a lost answer is followed by a
 * re-read, never a retry. The chats a rejected request named and the host still offers show as
 * failed, with Retry.
 */
export async function continueNativeChatRestartOffer(
  sessionIds: readonly string[] | undefined,
  reported: readonly string[] = sessionIds ?? []
): Promise<void> {
  actionsBegun += 1
  forgetUnsentResumes(sessionIds)
  const batch = [...reported]
  let outcome: Parameters<typeof announceRestartResults>
  resumeBatches.add(batch)
  syncResuming()
  try {
    const result = await callStructuredAgentSession<
      HostOfferPayload & { continued?: RestartContinuationOutcome[] }
    >(LOCAL, 'agentSession.restartContinue', sessionIds ? { sessionIds } : {})
    const listed = Array.isArray(result.failed) ? failedFrom(result) : undefined
    if (Array.isArray(result.sessions)) {
      publishAnswer({ candidates: result.sessions, failed: listed ?? [], listedAt: Date.now() })
    } else {
      await refreshNativeChatRestartOffer()
    }
    outcome = [batch, result.continued, listed, reopenNativeChatRestartOffer]
  } catch (error) {
    // The row's reason is this side's own code, so the real error is kept in the log.
    console.warn('[native-chat-resume] resume request failed before reaching the chats', error)
    markUnsentResumes(batch, Date.now())
    const read = await readNativeChatRestartOffer()
    // Nothing reached the chats, so each is a failure of this resume as the list now shows it.
    const listed = read.available ? offer.failed : undefined
    outcome = [batch, [], listed, reopenNativeChatRestartOffer]
  } finally {
    actionsSettled += 1
    resumeBatches.delete(batch)
    syncResuming()
  }
  announceRestartResults(...outcome)
}

/**
 * Turning the offer down for good, which explicitly deletes the pending durable records.
 *
 * A failed write or unreachable host leaves the durable record untouched. The re-read puts it back
 * in the status bar; if that read fails too, the entry stays hidden until the next launch reads it.
 */
export async function dismissNativeChatRestartOffer(sessionIds?: readonly string[]): Promise<void> {
  actionsBegun += 1
  try {
    const result = await callStructuredAgentSession<HostOfferPayload>(
      LOCAL,
      'agentSession.restartResumableDismiss',
      // Named only for rows the dialog lists as failed: the host's own failures, or chats this side
      // marked after a lost resume request, which the host still lists as offers. The host is this
      // build, and it forgets named records of any state.
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

/**
 * This launch's single read of the offer, and the one decision the preference makes: ask, or
 * resume without asking.
 *
 * "Resume automatically" runs the identical call the button runs — reattach AND ask each agent to
 * carry on. Opening a chat remains a separate, read-only inspection action.
 *
 * Runs once however many surfaces mount, so the count and the dialog describe the same answer and
 * an opted-in launch cannot dispatch twice.
 */
async function loadLaunchOffer(): Promise<void> {
  // The preference belongs to this launch's request; later saves cannot dispatch another.
  const autoResume = useAppStore.getState().settings?.nativeChatResumeWorkOnRestart === true
  let read = await readNativeChatRestartOffer()
  // Host startup can race the renderer. Retry only failed reads, never a confirmed empty result,
  // so a transient startup gap does not strand a durable offer or add steady-state polling.
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
  await continueNativeChatRestartOffer(undefined, allResumeSessionIds(offered))
}

/**
 * The offer, fetching it on first use.
 *
 * `enabled` is a gate, not a trigger: settings arrive after the first render, so the fetch waits
 * for the flag rather than being lost when it was still undefined.
 */
export function useNativeChatRestartOffer(enabled: boolean): NativeChatRestartOffer {
  useEffect(() => {
    if (enabled) {
      // Fetched after mount, never awaited by startup: the workspace is usable first.
      launch ??= loadLaunchOffer()
    }
  }, [enabled])
  return useSyncExternalStore(subscribe, getNativeChatRestartOffer, getNativeChatRestartOffer)
}

/** The chats a resume is carrying on right now, whichever surface started it. */
export function useNativeChatRestartResuming(): readonly string[] {
  return useSyncExternalStore(subscribe, getNativeChatRestartResuming, getNativeChatRestartResuming)
}

/** @internal - tests need a clean module between cases. */
export function _resetNativeChatRestartOffer(): void {
  releaseOfferedChatWatch()
  offer = EMPTY
  forgetUnsentResumes(undefined)
  resumeBatches.clear()
  resuming = NOTHING_RESUMING
  actionsBegun = 0
  actionsSettled = 0
  launch = undefined
  listeners.clear()
}
