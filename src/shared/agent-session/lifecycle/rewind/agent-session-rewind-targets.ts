import { AGENT_SESSION_FORKED_FROM_PRESENTATION } from '../../agent-session-fork'
import { isAgentSessionRewindTarget, savedRewindKeys } from './agent-session-rewind'
import { readAgentJournalTurn } from '../records/agent-session-turn-record'
import type { StructuredAgentSessionState } from '../../structured-agent-session-reducer'
import type { AgentJournalCursor } from '../../journal/agent-session-journal-identity'
import {
  agentSessionContextFloorSequence,
  isAgentSessionContextClear
} from '../../agent-session-context-clear'

/** User messages past `floor` the host can rewind to. */
export function agentSessionRewindTargetIds(
  { items, submissions }: Pick<StructuredAgentSessionState, 'items' | 'submissions'>,
  floor: number
): ReadonlySet<string> {
  const opener = turnOpeners(items)
  const keys = savedRewindKeys(submissions)
  return new Set(
    items
      .filter(
        (item) =>
          item.sequence > floor &&
          (keys.nativeIdentity(item.itemId) !== null || !keys.hasSubmission(item.itemId)) &&
          isAgentSessionRewindTarget(item, (turn) => opener.get(turn))
      )
      .map((item) => item.itemId)
  )
}

function turnOpeners(items: StructuredAgentSessionState['items']): Map<string, string> {
  const openers = new Map<string, string>()
  for (const item of items) {
    const opener = readAgentJournalTurn(item.body)?.userItemId
    if (opener) {
      openers.set(item.itemId, opener)
    }
  }
  return openers
}

/** Rewind stays after inherited history, the latest /clear and the host's context floor. */
export function agentSessionRewindContextFloor(
  state: Pick<StructuredAgentSessionState, 'items' | 'epoch'>,
  contextFloor: AgentJournalCursor | undefined
): number {
  let floor = agentSessionContextFloorSequence(contextFloor, state.epoch)
  for (const item of state.items) {
    if (
      isAgentSessionContextClear(item.body) ||
      (item.body.kind === 'status' &&
        item.body.presentation === AGENT_SESSION_FORKED_FROM_PRESENTATION)
    ) {
      floor = Math.max(floor, item.sequence)
    }
  }
  return floor
}
