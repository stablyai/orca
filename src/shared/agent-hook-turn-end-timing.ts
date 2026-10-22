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

// Why: a record with no verified opening or native key yet (a new session, a pre-record row).
const UNOPENED_TURN = 'seed'

/** The hook body's turn facts the host folds into its turn record; in-process only. */
export function readHostTurnSignals(
  source: AgentHookSource,
  hookPayload: Record<string, unknown>,
  promptInteractionKey: string | undefined
): Pick<AgentHookEventPayload, 'stopHookActive' | 'nativeTurnKey'> {
  // Why: the agent's own turn id tells a new turn from a re-delivery even when no prompt hook
  // ran (Codex turns woken by agent mail, every Command Code turn).
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

/**
 * The one turn-end derivation every execution host runs (local main and the WSL relay). A turn
 * advances on the agent's native turn key (Codex `turn_id`, Command Code's transcript position)
 * or, without one, only on a prompt-opening event. A live root turn-end event is an identified
 * end, minted, when its turn is unused or a verified continuation re-entered after a blocking Stop
 * hook. A same-turn repeat is a proven duplicate only for an agent with both a native key and a
 * verified continuation flag; otherwise it is ambiguous (a repeat, or a turn whose opening never
 * arrived) and never mints. Restatements (replay, retry, idle reminder, enrichment) keep the end
 * shown in the current done segment. Keys are opaque: only compared for equality.
 */
export function reduceHostTurnEnd(
  previous: TurnEndTimingRow | undefined,
  event: AgentHookEventPayload,
  at: number,
  canMint: boolean
): HostTurnEnd {
  const shown = previous?.payload.state === 'done' ? pickHostTurnEnd(previous) : {}
  const done = event.payload.state === 'done'
  // Why: a relay, a result retry or a replay already decided this event's end; the host restates it,
  // except over a done segment it shows with no end of its own (a cancel it inferred), which keeps none.
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
  // Why: the agent's own turn id plus a verified continuation flag mean an unflagged repeat of
  // this turn's Stop is a duplicate delivery (Codex re-fires it flagged for a continuation).
  if (completed && sameTurn && event.nativeTurnKey && agentReportsStopHookContinuation(source)) {
    return { turnEndedAt: completed.endedAt, turnEndDisposition: 'identified', ...kept }
  }
  return {
    ...(shown.turnEndedAt !== undefined ? { turnEndedAt: shown.turnEndedAt } : {}),
    turnEndDisposition: 'ambiguous',
    ...kept
  }
}
