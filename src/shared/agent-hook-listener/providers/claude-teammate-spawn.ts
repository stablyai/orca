import {
  isClaudeTeammateLifecycleId,
  recordClaudeTeammateTaskDescription
} from '../../claude-subagent-roster'
import type { HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'
import { getOrCreateClaudeSubagentRoster } from './claude-roster-state'

// Captured Claude 2.1.308 names background_tasks entries by the lead Agent call’s spawn description.
export function recordClaudeTeammateSpawn(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): void {
  const input = hookPayload['tool_input']
  const response = hookPayload['tool_response']
  if (
    readString(hookPayload, 'tool_name') !== 'Agent' ||
    typeof input !== 'object' ||
    input === null ||
    typeof response !== 'object' ||
    response === null ||
    readString({ ...response }, 'status') !== 'teammate_spawned'
  ) {
    return
  }
  const agentId = readString({ ...response }, 'agent_id')
  // Why: Claude registers the teammate task under the whitespace-collapsed spawn description.
  const description = readString({ ...input }, 'description')
    ?.replace(/\s+/g, ' ')
    .trim()
  if (agentId && description && isClaudeTeammateLifecycleId(agentId)) {
    recordClaudeTeammateTaskDescription(
      getOrCreateClaudeSubagentRoster(state, paneKey),
      agentId,
      { agentType: readString({ ...response }, 'name'), description },
      Date.now()
    )
  }
}
