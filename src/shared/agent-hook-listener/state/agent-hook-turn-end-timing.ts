import type { AgentHookEventPayload, HostTurnRecord } from '../listener-event'
import { isNewTurnEvent, isTurnEndEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'
import type { AgentHookSource } from '../transport/agent-hook-relay'
import { agentMainAgentVerdict } from '../../agent-status/lifecycle/agent-main-agent-verdict'
import { agentReportsStopHookContinuation } from '../../agent-status/lifecycle/agent-stop-hook-continuation'
import {
  pickHostTurnEnd,
  type HostTurnEndFacts
} from '../../agent-status/contracts/agent-status-types'

type TurnEndTimingRow = Pick<
  AgentHookEventPayload,
  'turnEndedAt' | 'turnEndDisposition' | 'payload' | 'hostTurn'
>

type HostTurnEnd = HostTurnEndFacts & { hostTurn?: HostTurnRecord }

// No verified opener or native key exists for a seeded turn.
const UNOPENED_TURN = 'seed'

/** The hook body's turn facts the host folds into its turn record; in-process only. */
export function readHostTurnSignals(
  source: AgentHookSource,
  hookPayload: Record<string, unknown>,
  promptInteractionKey: string | undefined
): Pick<AgentHookEventPayload, 'stopHookActive' | 'nativeTurnKey'> {
  // Native keys distinguish new turns from redelivery when no prompt hook ran (Codex mail/Command Code).
  const nativeTurnKey =
    source === 'codex'
      ? readString(hookPayload, 'turn_id')
      : source === 'command-code'
        ? promptInteractionKey
        : undefined
  return {
    ...(hookPayload.stop_hook_active === true && agentReportsStopHookContinuation(source)
      ? { stopHookActive: true }
      : {}),
    ...(nativeTurnKey ? { nativeTurnKey } : {})
  }
}

export function isTurnEndedAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function resolveOwner(
  previous: HostTurnRecord | undefined,
  event: AgentHookEventPayload & { source: NonNullable<AgentHookEventPayload['source']> }
): { owner: string; replaced: boolean } {
  const anonymous = `${event.source}:`
  const sessionId = event.providerSession?.id
  if (!sessionId) {
    // Why: an event that names no session belongs to whichever session of this agent is current.
    return previous?.owner.startsWith(anonymous)
      ? { owner: previous.owner, replaced: false }
      : { owner: anonymous, replaced: previous !== undefined }
  }
  const owner = `${anonymous}${sessionId}`
  return {
    owner,
    replaced: previous !== undefined && previous.owner !== owner && previous.owner !== anonymous
  }
}

/** Shared host turn-end derivation: native opaque keys or prompt openers advance turns; unused live root ends or verified Stop continuations mint. Same-turn repeats are duplicates only with native keys plus continuation support; ambiguous ends never mint. Replays/retries/reminders restate the current done segment. */
export function reduceHostTurnEnd(
  previous: TurnEndTimingRow | undefined,
  event: AgentHookEventPayload,
  at: number,
  canMint: boolean
): HostTurnEnd {
  const done = event.payload.state === 'done'
  const rootDone = done || event.payload.mainAgent?.state === 'done'
  const previousRootDone =
    previous?.payload.state === 'done' || previous?.payload.mainAgent?.state === 'done'
  let shown = previousRootDone ? pickHostTurnEnd(previous!) : {}
  const source = event.source
  const isLiveRoot =
    source !== undefined && event.toolAgentId === undefined && event.providerSessionOnly !== true
  if (
    isLiveRoot &&
    (source === 'claude' || source === 'codex') &&
    (event.payload.sessionBoundary === true ||
      (source === 'claude' && event.hookEventName === 'SessionStart'))
  ) {
    const { owner, replaced } = resolveOwner(previous?.hostTurn, { ...event, source })
    const record =
      previous?.hostTurn && !replaced
        ? { ...previous.hostTurn, owner }
        : { owner, currentTurnKey: UNOPENED_TURN }
    // Compact retires an ended cut without completing live work or opening a prompt.
    return {
      hostTurn:
        event.payload.sessionBoundary === true
          ? { owner, currentTurnKey: UNOPENED_TURN }
          : rootDone
            ? { ...record, currentTurnKey: UNOPENED_TURN }
            : record
    }
  }
  // Restate an already-derived/replayed end, except over an inferred-cancel segment that has none.
  if (!canMint || event.isReplay === true) {
    const sourceAdvanced =
      event.isReplay !== true &&
      ((isLiveRoot && isNewTurnEvent(source, event.hookEventName)) ||
        (event.connectionId !== null && event.turnEndDisposition === 'identified'))
    if (previous?.hostTurn?.currentTurnKey === UNOPENED_TURN && !sourceAdvanced) {
      return { hostTurn: previous.hostTurn }
    }
    const shownWithoutEnd =
      previous?.hostTurn?.currentTurnKey !== UNOPENED_TURN &&
      previous?.payload.state === 'done' &&
      previous.turnEndDisposition === undefined
    return {
      ...(done
        ? event.turnEndDisposition !== undefined && !shownWithoutEnd
          ? pickHostTurnEnd(event)
          : shown
        : {}),
      ...(previous?.hostTurn && !sourceAdvanced ? { hostTurn: previous.hostTurn } : {})
    }
  }
  let record = previous?.hostTurn
  if (isLiveRoot) {
    const { owner, replaced } = resolveOwner(record, { ...event, source })
    if (!record || replaced) {
      record = { owner, currentTurnKey: UNOPENED_TURN }
    } else if (record.owner !== owner) {
      record = { ...record, owner }
    }
    if (event.nativeTurnKey) {
      record = { ...record, currentTurnKey: `turn:${event.nativeTurnKey}` }
    } else if (
      isNewTurnEvent(source, event.hookEventName) &&
      event.payload.sessionBoundary !== true
    ) {
      record = { ...record, currentTurnKey: `opened:${at}` }
    }
  }
  const sameRoot =
    record?.owner === previous?.hostTurn?.owner &&
    record?.currentTurnKey === previous?.hostTurn?.currentTurnKey
  if (
    !sameRoot &&
    (source === 'claude' ||
      source === 'codex' ||
      (source !== undefined && isNewTurnEvent(source, event.hookEventName)))
  ) {
    shown = {}
  }
  const kept = record ? { hostTurn: record } : {}
  if (!rootDone) {
    return kept
  }
  // Cancellation consumes the root even while children keep its pane working.
  if (record && agentMainAgentVerdict(event.payload) === 'cancellation') {
    if (record.currentTurnKey === UNOPENED_TURN) {
      return { hostTurn: record }
    }
    return {
      ...(isLiveRoot &&
      isTurnEndEvent(source, event.hookEventName) &&
      record.completed?.turnKey === record.currentTurnKey
        ? { turnEndDisposition: 'ambiguous' as const }
        : {}),
      hostTurn:
        record.completed?.turnKey === record.currentTurnKey
          ? record
          : { ...record, completed: { turnKey: record.currentTurnKey, endedAt: at } }
    }
  }
  // Result enrichment carries raw source facts; process lifecycle before restating them.
  if (
    sameRoot &&
    record?.currentTurnKey !== UNOPENED_TURN &&
    event.turnEndDisposition !== undefined
  ) {
    return { ...pickHostTurnEnd(event), ...kept }
  }
  if (
    !record ||
    !isLiveRoot ||
    event.payload.sessionBoundary === true ||
    !(
      isTurnEndEvent(source, event.hookEventName) ||
      (source === 'codex' && event.transcriptTurnEnd === true && event.nativeTurnKey !== undefined)
    )
  ) {
    return { ...shown, ...kept }
  }
  const completed = record.completed
  const sameTurn = completed?.turnKey === record.currentTurnKey
  if (record.currentTurnKey !== UNOPENED_TURN && (event.stopHookActive === true || !sameTurn)) {
    const endedAt = Math.max(at, (completed?.endedAt ?? 0) + 1)
    return {
      turnEndedAt: endedAt,
      turnEndDisposition: 'identified',
      hostTurn: { ...record, completed: { turnKey: record.currentTurnKey, endedAt } }
    }
  }
  // With native identity and continuation support, an unflagged same-turn Stop is a duplicate.
  if (completed && sameTurn && event.nativeTurnKey && agentReportsStopHookContinuation(source)) {
    return { turnEndedAt: completed.endedAt, turnEndDisposition: 'identified', ...kept }
  }
  return {
    ...(shown.turnEndedAt !== undefined ? { turnEndedAt: shown.turnEndedAt } : {}),
    turnEndDisposition: 'ambiguous',
    ...kept
  }
}
