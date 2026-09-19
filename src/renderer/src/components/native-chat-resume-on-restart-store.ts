import { useEffect, useSyncExternalStore } from 'react'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { useAppStore } from '../store'
import {
  announceRestartResults,
  announceRestartUnconfirmed,
  type RestartActionOutcome
} from './native-chat-restart-action-notifications'
import { allResumeSessionIds, type ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import { requestNativeChatResumeOnRestartDialog } from './native-chat-resume-on-restart-dialog'

/**
 * Which interrupted chats the host is still offering to reconnect.
 *
 * The offer is the HOST's answer, not a list whichever surface rendered first happens to be
 * holding. It has to be, because the host retires an offer for reasons no renderer can see —
 * simply reopening a chat re-acquires its provider at the same cursor, which is the whole of what
 * reconnecting would have done. So this fetches the list and both surfaces read it, and anything
 * about to ACT on the offer asks the host again first.
 *
 * What stays on this side is the user's own facts: the snooze, and the preference that decides
 * whether the launch asks at all.
 */

// Structured sessions run on the machine hosting the runtime; both launch resolvers refuse anything
// else, so there is no remote target to aim this at.
const LOCAL = { kind: 'local' } as const

export type NativeChatRestartOffer = Readonly<{
  candidates: readonly ResumeCandidate[]
  /** Stamped when the list arrived. Row ages read against this rather than a render-time
   *  `Date.now()`, so they stay stable across re-renders and the render stays pure. */
  listedAt: number
}>

const EMPTY: NativeChatRestartOffer = { candidates: [], listedAt: 0 }
let offer: NativeChatRestartOffer = EMPTY
let launch: Promise<void> | undefined
const listeners = new Set<() => void>()

/** The snapshot object is replaced HERE and nowhere else — never during a render — so every
 *  `useSyncExternalStore` reader sees the same reference until a host answer or a user action
 *  actually moves the offer. */
function publish(next: NativeChatRestartOffer): void {
  offer = next
  for (const listener of listeners) {
    listener()
  }
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
 * Called before the dialog is reopened, so a count can never name a chat the host would now refuse
 * — and a chat already recovered by being opened is gone from the list rather than offered again.
 */
export async function refreshNativeChatRestartOffer(): Promise<readonly ResumeCandidate[]> {
  try {
    const offered = await callStructuredAgentSession<{ sessions: ResumeCandidate[] }>(
      LOCAL,
      'agentSession.restartResumable'
    )
    publish({ candidates: offered.sessions, listedAt: Date.now() })
    return offered.sessions
  } catch {
    // A host that cannot answer says nothing new. The last answer it did give is still actionable:
    // every action re-derives the predicate on the host regardless of what is sent.
    return offer.candidates
  }
}

/** Drops the chats the host reports it has settled, leaving the ones it did not. */
export function settleNativeChatRestartOffer(sessionIds: readonly string[]): void {
  const settled = new Set(sessionIds)
  const remaining = offer.candidates.filter((candidate) => !settled.has(candidate.sessionId))
  if (remaining.length === offer.candidates.length) {
    return
  }
  publish({ ...offer, candidates: remaining })
}

/** The offer was abandoned outright; the host has already spent the markers. */
export function clearNativeChatRestartOffer(): void {
  if (offer.candidates.length === 0) {
    return
  }
  publish({ ...offer, candidates: [] })
}

/**
 * This launch's single read of the offer, and the one decision the preference makes: ask, or
 * reconnect without asking.
 *
 * Runs once however many surfaces mount, so the count and the dialog describe the same answer and
 * an opted-in launch cannot dispatch twice.
 */
async function loadLaunchOffer(): Promise<void> {
  // The preference belongs to this launch's request; later saves cannot dispatch another.
  const autoResume = useAppStore.getState().settings?.nativeChatResumeWorkOnRestart === true
  const offered = await refreshNativeChatRestartOffer()
  if (offered.length === 0) {
    return
  }
  if (!autoResume) {
    requestNativeChatResumeOnRestartDialog()
    return
  }
  // Identical call to the dialog's own button; the host re-derives eligibility either way.
  const result = await callStructuredAgentSession<{ results: RestartActionOutcome[] }>(
    LOCAL,
    'agentSession.restartResume',
    {}
  ).catch(() => null)
  if (!result) {
    announceRestartUnconfirmed(offered.length, 'reconnect')
    return
  }
  // Automatic must never be silent: someone who ticked the box months ago still sees this.
  announceRestartResults(allResumeSessionIds(offered), result.results, 'reconnect')
  settleNativeChatRestartOffer(result.results.map((entry) => entry.sessionId))
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

/** @internal - tests need a clean module between cases. */
export function _resetNativeChatRestartOffer(): void {
  offer = EMPTY
  launch = undefined
  listeners.clear()
}
