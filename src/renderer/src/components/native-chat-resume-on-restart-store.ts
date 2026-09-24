import { useEffect, useSyncExternalStore } from 'react'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { useAppStore } from '../store'
import {
  announceRestartDismissUnconfirmed,
  announceRestartResults,
  announceRestartUnconfirmed,
  type RestartContinuationOutcome
} from './native-chat-restart-action-notifications'
import { allResumeSessionIds, type ResumeCandidate } from './native-chat-resume-on-restart-grouping'
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
  /** Stamped when the list arrived. Row ages read against this rather than a render-time
   *  `Date.now()`, so they stay stable across re-renders and the render stays pure. */
  listedAt: number
}>

const EMPTY: NativeChatRestartOffer = { candidates: [], listedAt: 0 }
let offer: NativeChatRestartOffer = EMPTY
let launch: Promise<void> | undefined
const listeners = new Set<() => void>()
const LAUNCH_READ_RETRY_DELAYS_MS = [100, 250, 500] as const

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
 * Called before the dialog is reopened, so a count can never name a chat the host would now refuse.
 */
type HostOfferRead = {
  candidates: readonly ResumeCandidate[]
  available: boolean
}

async function readNativeChatRestartOffer(): Promise<HostOfferRead> {
  try {
    const offered = await callStructuredAgentSession<{ sessions: ResumeCandidate[] }>(
      LOCAL,
      'agentSession.restartResumable'
    )
    if (!Array.isArray(offered.sessions)) {
      throw new Error('agent_session_restart_offer_invalid')
    }
    publish({ candidates: offered.sessions, listedAt: Date.now() })
    return { candidates: offered.sessions, available: true }
  } catch {
    // A failed read is not an answer. Hide the last snapshot so a modal can never present a
    // candidate the host has not confirmed; the durable record remains and a later refresh can
    // restore it.
    publish({ candidates: [], listedAt: Date.now() })
    return { candidates: [], available: false }
  }
}

export async function refreshNativeChatRestartOffer(): Promise<readonly ResumeCandidate[]> {
  return (await readNativeChatRestartOffer()).candidates
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
  try {
    const result = await callStructuredAgentSession<{
      /** Which chats the host reattached. */
      resumed?: { sessionId: string }[]
      continued: RestartContinuationOutcome[]
      sessions?: ResumeCandidate[]
    }>(LOCAL, 'agentSession.restartContinue', sessionIds ? { sessionIds } : {})
    announceRestartResults(reported, result.continued)
    if (Array.isArray(result.sessions)) {
      publish({ candidates: result.sessions, listedAt: Date.now() })
    } else {
      await refreshNativeChatRestartOffer()
    }
  } catch {
    await refreshNativeChatRestartOffer()
    announceRestartUnconfirmed(reported.length)
  }
}

/**
 * Turning the offer down for good, which explicitly deletes the pending durable records.
 *
 * A failed write or unreachable host leaves the durable record untouched; a later read can restore
 * the offer after the host is available again.
 */
export async function dismissNativeChatRestartOffer(): Promise<void> {
  try {
    const result = await callStructuredAgentSession<{ sessions?: ResumeCandidate[] }>(
      LOCAL,
      'agentSession.restartResumableDismiss',
      {}
    )
    if (Array.isArray(result.sessions)) {
      publish({ candidates: result.sessions, listedAt: Date.now() })
    } else {
      await refreshNativeChatRestartOffer()
    }
  } catch {
    await refreshNativeChatRestartOffer()
    announceRestartDismissUnconfirmed()
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

/** @internal - tests need a clean module between cases. */
export function _resetNativeChatRestartOffer(): void {
  offer = EMPTY
  launch = undefined
  listeners.clear()
}
