import type { AgentStatusPayload } from '../contracts/agent-status-types'
import { isAgentChildWork, isLiveChildWork } from '../child-work/agent-status-child-work-liveness'
import type { AgentChildWorkRecord } from '../child-work/agent-status-child-work'
import {
  AGENT_STATUS_BACKGROUND_COMMANDS_MAX,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  normalizeOptionalField
} from '../contracts/agent-status-field-normalization'
import { redactString } from '../../observability/redactor'

/** The lead agent ended its turn while background tasks it started still run: when, and what they run. */
export type AgentBackgroundWait = { since: number; commands: string[] }

/** Exact from the row: the lead's turn is over (not cancelled or failed), and only its named background tasks keep
 *  the row working. A session cron alone names no task, so it is no wait. */
export function agentBackgroundWait(
  row: Pick<AgentStatusPayload, 'state' | 'workingMode' | 'mainAgent' | 'backgroundCommands'>
): AgentBackgroundWait | null {
  const lead = row.mainAgent
  if (
    row.state !== 'working' ||
    row.workingMode !== 'monitoring' ||
    lead?.state !== 'done' ||
    lead.outcome === 'cancellation' ||
    lead.outcome === 'failure' ||
    !row.backgroundCommands?.length
  ) {
    return null
  }
  return { since: lead.stateStartedAt, commands: row.backgroundCommands }
}

/** A chat's live background tasks, as a status row names them. */
export function childWorkBackgroundCommands(
  children: readonly Pick<
    AgentChildWorkRecord,
    'kind' | 'state' | 'membership' | 'description' | 'name' | 'operation'
  >[]
): string[] | undefined {
  const commands = children.flatMap((child) =>
    child.membership === 'live' && isLiveChildWork(child) && !isAgentChildWork(child)
      ? [
          normalizeOptionalField(
            redactString(child.operation?.input ?? child.description ?? child.name ?? ''),
            AGENT_STATUS_TOOL_INPUT_MAX_LENGTH
          ) ?? 'background task'
        ]
      : []
  )
  return commands.length > 0 ? commands.slice(0, AGENT_STATUS_BACKGROUND_COMMANDS_MAX) : undefined
}
