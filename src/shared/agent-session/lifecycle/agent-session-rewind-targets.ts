import { isAgentSessionRewindTarget, savedRewindKeys } from './agent-session-rewind'
import { readAgentJournalTurn } from './agent-session-turn-record'
import type { StructuredAgentSessionState } from '../structured-agent-session-reducer'
import type { AgentJournalCursor } from '../journal/agent-session-journal-identity'
import {
  agentSessionContextFloorSequence,
  latestAgentSessionContextClearSequence
} from '../agent-session-context-clear'

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

/** The sequence a rewind target must be past: the latest /clear, or the host's context floor. */
export function agentSessionRewindContextFloor(
  state: Pick<StructuredAgentSessionState, 'items' | 'epoch'>,
  contextFloor: AgentJournalCursor | undefined
): number {
  return Math.max(
    latestAgentSessionContextClearSequence(state.items),
    agentSessionContextFloorSequence(contextFloor, state.epoch)
  )
}
