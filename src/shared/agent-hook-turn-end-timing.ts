import type { AgentHookEventPayload, HostTurnRecord } from './agent-hook-listener/listener-event'
import { isNewTurnEvent, isTurnEndEvent } from './agent-hook-listener/provider-event-routing'
import { readString } from './agent-hook-listener/tool-input-preview'
import type { AgentHookSource } from './agent-hook-relay'
import { agentMainAgentVerdict } from './agent-main-agent-verdict'
import { agentReportsStopHookContinuation } from './agent-stop-hook-continuation'
import { pickHostTurnEnd, type HostTurnEndFacts } from './agent-status-types'

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

// Why: a settled cancellation ends the open turn, so that turn's late end is a repeat, not an end.
function endsTurnByCancellation(row: TurnEndTimingRow | undefined): boolean {
  return (
    row?.payload.state === 'done' &&
    row.turnEndDisposition === undefined &&
    agentMainAgentVerdict(row.payload) === 'cancellation'
  )
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
  const shown = previous?.payload.state === 'done' ? pickHostTurnEnd(previous) : {}
  const done = event.payload.state === 'done'
  // Restate an already-derived/replayed end, except over an inferred-cancel segment that has none.
  if (!canMint || event.isReplay === true || event.turnEndDisposition !== undefined) {
    const shownWithoutEnd =
      previous?.payload.state === 'done' && previous.turnEndDisposition === undefined
    return {
      ...(done
        ? event.turnEndDisposition !== undefined && !shownWithoutEnd
          ? pickHostTurnEnd(event)
          : shown
        : {}),
      ...(previous?.hostTurn ? { hostTurn: previous.hostTurn } : {})
    }
  }
  let record = previous?.hostTurn
  const source = event.source
  const isLiveRoot =
    source !== undefined && event.toolAgentId === undefined && event.providerSessionOnly !== true
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
  const kept = record ? { hostTurn: record } : {}
  if (!done) {
    return kept
  }
  if (
    !record ||
    !isLiveRoot ||
    event.payload.sessionBoundary === true ||
    !isTurnEndEvent(source, event.hookEventName)
  ) {
    if (
      record &&
      record.completed?.turnKey !== record.currentTurnKey &&
      endsTurnByCancellation(event)
    ) {
      const completed = { turnKey: record.currentTurnKey, endedAt: at }
      return { ...shown, hostTurn: { ...record, completed } }
    }
    return { ...shown, ...kept }
  }
  const completed = record.completed
  const sameTurn = completed?.turnKey === record.currentTurnKey
  if (event.stopHookActive === true || (!sameTurn && record.currentTurnKey !== UNOPENED_TURN)) {
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
