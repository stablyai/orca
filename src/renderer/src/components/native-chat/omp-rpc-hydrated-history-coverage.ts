// What a drained RPC history snapshot still covers, and what retires that
// claim. Split from the reducer because the rules are about the SESSION as
// drained rather than about the turn.
//
// The claim is reporting only: no pagination decision may be taken from it
// (SA-010). RPC history walks the active leaf while the JSONL transcript also
// retains abandoned-branch records, so covering the one never answers for the
// other — `canLoadEarlierNativeChatHistory` deliberately takes no RPC input.

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'
import { capHydratedHistory } from './omp-rpc-overlay-retention'

/** A drained history snapshot for this session, decoded main-side. Whole
 *  snapshot or nothing — a partial walk cannot be spliced onto a later one
 *  (drainOmpRpcHistory), and the same holds one layer up. `totalMessages` is
 *  the wire count, which stays the truth even when the retained window below
 *  is smaller. */
export type OmpRpcHydratedHistory = {
  messages: NativeChatMessage[]
  /** The wire truth from the drain, which can exceed `messages.length`. */
  totalMessages: number
  /** Whether `messages` still holds the entire drained snapshot. False once the
   *  retention budget dropped its head (omp-rpc-overlay-retention.ts). */
  coversWholeSession: boolean
  /** The session this snapshot was drained from — the pane's acquired identity,
   *  which is the ONLY identity known before the session publishes one of its
   *  own (see `applyOmpRpcPublishedSessionIdentity`). Null when the drain
   *  reported none. */
  sessionId: string | null
}

/** How a published session identity lands on the pane's state.
 *
 *  The owning session publishes no identity at acquisition — upstream's
 *  `handleRpcSessionChange` emits `available_commands_update` and no
 *  `session_info_update` — so main synthesizes one when a command moves the
 *  child (omp-rpc-chat-session.ts). That synthesized frame can therefore be the
 *  FIRST identity event a pane ever sees while already describing a DIFFERENT
 *  session, which is why "invalidate only when a published id is already known"
 *  was not enough (XLR-025): it preserved session A's snapshot while the pane
 *  repointed its transcript at B, and the merge then folded A's records into
 *  B's history. The snapshot's own drain identity supplies the missing
 *  "previous". A snapshot that reports no identity still proves nothing, so it
 *  is kept — the pre-existing behavior for the case main cannot name.
 *
 *  Invalidation is gated on the incoming id EXISTING as well as differing,
 *  which keeps this rule aligned with the one consumer that acts on it: a
 *  published id is also what repoints the pane's effective transcript
 *  (NativeChatResolvedView), so an id-less frame — a title-only rename —
 *  moves neither, and dropping the snapshot for it would lose history nothing
 *  re-drains. */
export function applyOmpRpcPublishedSessionIdentity(
  state: {
    sessionInfo: { sessionId: string | null } | null
    hydratedHistory: OmpRpcHydratedHistory | null
    boundSessionId?: string | null
  },
  published: { title: string | null; sessionId: string | null }
): {
  sessionInfo: { title: string | null; sessionId: string | null }
  /** True when the published id PROVES the pane moved to another session. The
   *  hydrated snapshot is only the first thing that invalidates: every other
   *  projection the pane holds describes the old session too (XLR-033), so the
   *  verdict is reported rather than applied here. */
  switched: boolean
} {
  const sessionInfo = {
    title: published.title,
    sessionId: published.sessionId ?? state.sessionInfo?.sessionId ?? null
  }
  const bound =
    state.sessionInfo?.sessionId ?? state.hydratedHistory?.sessionId ?? state.boundSessionId ?? null
  return {
    sessionInfo,
    switched: sessionInfo.sessionId !== null && bound !== null && bound !== sessionInfo.sessionId
  }
}

/** Frames that prove the session grew past the drained snapshot: a turn
 *  starting, or the message stream carrying a record. `session-info` /
 *  `config-update` / `recap-update` only report ON the session, so they leave
 *  the coverage claim alone. */
export function growsSessionPastSnapshot(event: OmpRpcClientEvent): boolean {
  return (
    event.kind === 'agent-start' ||
    event.kind === 'turn-start' ||
    event.kind === 'message-start' ||
    event.kind === 'message-update'
  )
}

/** Retires a snapshot's whole-session coverage claim without discarding the
 *  snapshot. The claim is about the SESSION as drained, not about the array, so
 *  it cannot outlive the drain: once a later turn appends records the snapshot
 *  never saw, the snapshot no longer describes the session. The records
 *  themselves stay — they are still real history. */
export function expireHydratedHistoryCoverage(
  history: OmpRpcHydratedHistory | null
): OmpRpcHydratedHistory | null {
  return history?.coversWholeSession ? { ...history, coversWholeSession: false } : history
}

/**
 * The snapshot a drain lands as. The drain is always whole (drainOmpRpcHistory
 * never reports a partial walk), but the RETAINED window may not be: record
 * which, so a consumer can tell a snapshot that still holds its whole drain
 * from one the retention budget truncated. Growth already seen refuses the
 * claim outright — a drain that started before that growth cannot contain it,
 * and nothing on the wire says which came first.
 */
export function buildOmpRpcHydratedHistory(
  drained: { messages: NativeChatMessage[]; totalMessages: number; sessionId?: string | null },
  observedSessionGrowth: boolean
): OmpRpcHydratedHistory {
  const messages = capHydratedHistory(drained.messages)
  return {
    messages,
    totalMessages: drained.totalMessages,
    coversWholeSession: messages.length === drained.messages.length && !observedSessionGrowth,
    sessionId: drained.sessionId ?? null
  }
}
