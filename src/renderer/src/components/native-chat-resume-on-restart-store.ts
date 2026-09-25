import { useEffect, useSyncExternalStore } from 'react'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import {
  getStructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusFeedOwner
} from '@/runtime/structured-agent-session-status-feed'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { useAppStore } from '../store'
import {
  announceRestartDismissUnconfirmed,
  announceRestartResults,
  announceRestartUnconfirmed,
  type RestartContinuationOutcome
} from './native-chat-restart-action-notifications'
import {
  allResumeSessionIds,
  type ResumeCandidate,
  type ResumeFailure
} from './native-chat-resume-on-restart-grouping'
import { requestNativeChatResumeOnRestartDialog } from './native-chat-resume-on-restart-dialog'

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
const listeners = new Set<() => void>()
const LAUNCH_READ_RETRY_DELAYS_MS = [100, 250, 500] as const

/** The snapshot object is replaced HERE and nowhere else — never during a render — so every
 *  `useSyncExternalStore` reader sees the same reference until a host answer or a user action
 *  actually moves the offer. */
function publish(next: NativeChatRestartOffer): void {
  offer = next
  syncFailedChatWatch()
  for (const listener of listeners) {
    listener()
  }
}

/**
 * Re-reads the host once a failed chat shows new activity, so a reply the user sent there retires
 * its entry here too. The host stays the judge; this only asks again.
 *
 * Held only while something failed. Keyed on status and prompt rather than every summary, so an
 * agent streaming in a failed chat costs one re-read, not one per tool call.
 */
const FAILED_CHAT_REFRESH_DELAY_MS = 500
let failedChatWatch: {
  feed: StructuredAgentSessionStatusFeedOwner
  seen: Map<string, string>
  release: () => void
} | null = null
let failedChatRefresh: ReturnType<typeof setTimeout> | null = null

function failedChatActivityKey(summary: AgentSessionStatusSummary): string {
  return `${summary.status ?? ''}\u0000${summary.latestPrompt}`
}

function syncFailedChatWatch(): void {
  const failedIds = new Set(offer.failed.map((failure) => failure.sessionId))
  if (failedIds.size === 0) {
    releaseFailedChatWatch()
    return
  }
  if (!failedChatWatch) {
    const feed = getStructuredAgentSessionStatusFeed(LOCAL)
    const unsubscribe = feed.subscribe(noticeFailedChatActivity)
    const deactivate = feed.activate()
    failedChatWatch = {
      feed,
      seen: new Map(),
      release: () => {
        unsubscribe()
        deactivate()
      }
    }
  }
  const { feed, seen } = failedChatWatch
  for (const sessionId of seen.keys()) {
    if (!failedIds.has(sessionId)) {
      seen.delete(sessionId)
    }
  }
  // What the feed already holds is what this listing answered.
  for (const sessionId of failedIds) {
    const summary = feed.getSnapshot().get(sessionId)
    if (summary && !seen.has(sessionId)) {
      seen.set(sessionId, failedChatActivityKey(summary))
    }
  }
}

function noticeFailedChatActivity(): void {
  if (!failedChatWatch) {
    return
  }
  const { feed, seen } = failedChatWatch
  const snapshot = feed.getSnapshot()
  let changed = false
  for (const failure of offer.failed) {
    const summary = snapshot.get(failure.sessionId)
    if (!summary) {
      continue
    }
    const key = failedChatActivityKey(summary)
    const previous = seen.get(failure.sessionId)
    if (previous !== key) {
      seen.set(failure.sessionId, key)
      // A first sighting is news only if newer than the list; a change to a known chat always is,
      // since the host may have answered the list just before the change was delivered here.
      changed ||= previous !== undefined || summary.updatedAt > offer.listedAt
    }
  }
  if (changed && failedChatRefresh === null) {
    failedChatRefresh = setTimeout(() => {
      failedChatRefresh = null
      if (actionsBegun === actionsSettled) {
        const issued = actionsBegun
        void readNativeChatRestartOffer(() => actionsBegun === issued)
      }
    }, FAILED_CHAT_REFRESH_DELAY_MS)
  }
}

function releaseFailedChatWatch(): void {
  if (failedChatRefresh !== null) {
    clearTimeout(failedChatRefresh)
    failedChatRefresh = null
  }
  failedChatWatch?.release()
  failedChatWatch = null
}

export function getNativeChatRestartOffer(): NativeChatRestartOffer {
  return offer
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
      publish({ candidates: offered.sessions, failed, listedAt: Date.now() })
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

export async function refreshNativeChatRestartOffer(): Promise<
  Pick<HostOfferRead, 'candidates' | 'failed'>
> {
  const read = await readNativeChatRestartOffer()
  return { candidates: read.candidates, failed: read.failed }
}

/** What the failure toast can do. The dialog request is external state the toast may raise after
 *  the dialog that started the action has closed. */
const failureToastActions = {
  show: () => requestNativeChatResumeOnRestartDialog(),
  dismiss: (sessionIds: readonly string[]) => {
    void dismissNativeChatRestartOffer([...sessionIds])
  }
}

/**
 * Reattach the offered chats, ask each agent to carry on, then replace the offer with the host's
 * authoritative remaining list. This keeps the modal and status bar synchronized after every
 * action, even when the dialog's snapshot became stale while it was open.
 *
 * `sessionIds` is the dialog's selection. An opted-in launch names nothing, so the host acts on
 * whatever it still offers rather than on a list this side captured a moment earlier, and passes
 * `reported` instead: the chats the user was shown, which is what the toasts count.
 *
 * Never rejects. The payload is unvalidated, and a shape this side did not expect is reported as
 * an unconfirmed delivery — the message may well have gone out.
 */
export async function continueNativeChatRestartOffer(
  sessionIds: readonly string[] | undefined,
  reported: readonly string[] = sessionIds ?? []
): Promise<void> {
  actionsBegun += 1
  try {
    const result = await callStructuredAgentSession<
      HostOfferPayload & {
        /** Which chats the host reattached. */
        resumed?: { sessionId: string }[]
        continued: RestartContinuationOutcome[]
      }
    >(LOCAL, 'agentSession.restartContinue', sessionIds ? { sessionIds } : {})
    const failed = failedFrom(result)
    announceRestartResults(
      reported,
      result.continued,
      Array.isArray(result.failed) ? failed : undefined,
      failureToastActions
    )
    if (Array.isArray(result.sessions)) {
      publish({ candidates: result.sessions, failed, listedAt: Date.now() })
    } else {
      await refreshNativeChatRestartOffer()
    }
  } catch {
    await refreshNativeChatRestartOffer()
    announceRestartUnconfirmed(reported.length)
  } finally {
    actionsSettled += 1
  }
}

/**
 * Turning the offer down for good, which explicitly deletes the pending durable records.
 *
 * A failed write or unreachable host leaves the durable record untouched; a later read can restore
 * the offer after the host is available again.
 */
export async function dismissNativeChatRestartOffer(sessionIds?: readonly string[]): Promise<void> {
  actionsBegun += 1
  try {
    const result = await callStructuredAgentSession<HostOfferPayload>(
      LOCAL,
      'agentSession.restartResumableDismiss',
      // Named only for rows the host itself listed as failures, which an older host never does,
      // so it is never asked to understand the key.
      sessionIds ? { sessionIds: [...sessionIds] } : {}
    )
    if (Array.isArray(result.sessions)) {
      publish({ candidates: result.sessions, failed: failedFrom(result), listedAt: Date.now() })
    } else {
      await refreshNativeChatRestartOffer()
    }
  } catch {
    await refreshNativeChatRestartOffer()
    announceRestartDismissUnconfirmed()
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
  // Asked whatever Chat UI says: the host answers empty without starting when it holds no chat.
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
 * Waits for settings, which arrive after the first render, because the launch reads the resume
 * preference from them.
 */
export function useNativeChatRestartOffer(): NativeChatRestartOffer {
  const settingsLoaded = useAppStore((store) => store.settings !== null)
  useEffect(() => {
    if (settingsLoaded) {
      // Fetched after mount, never awaited by startup: the workspace is usable first.
      launch ??= loadLaunchOffer()
    }
  }, [settingsLoaded])
  return useSyncExternalStore(subscribe, getNativeChatRestartOffer, getNativeChatRestartOffer)
}

/** @internal - tests need a clean module between cases. */
export function _resetNativeChatRestartOffer(): void {
  releaseFailedChatWatch()
  offer = EMPTY
  actionsBegun = 0
  actionsSettled = 0
  launch = undefined
  listeners.clear()
}
