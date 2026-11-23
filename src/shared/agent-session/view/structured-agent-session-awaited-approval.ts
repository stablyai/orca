import type { AgentSessionAwaitedApproval } from '../agent-session-wire'
import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { approvalRecordTool } from '../requests/prompts/agent-session-approval-tool'
import { describeToolInput } from '../../native-chat/tools/native-chat-tool-summary'
import {
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  normalizeOptionalField
} from '../../agent-status/contracts/agent-status-field-normalization'
import { AGENT_STATUS_TOOL_NAME_MAX_LENGTH } from '../../agent-status/contracts/agent-status-types'

/** The tool the first prompt waiting on the person asks to run, and its command's first line, when
 *  that prompt is an approval; a list names it without the chat's rows. */
export function structuredAgentSessionAwaitedApproval(
  first: AgentJournalRenderItem | undefined
): AgentSessionAwaitedApproval | undefined {
  if (first?.body.kind !== 'approval') {
    return undefined
  }
  const { body } = first
  const tool = normalizeOptionalField(
    approvalRecordTool(body.toolName, body.displayName ?? body.title),
    AGENT_STATUS_TOOL_NAME_MAX_LENGTH
  )
  if (!tool) {
    return undefined
  }
  // As the working status names a tool's input: its command, file or URL, not the JSON around it.
  const line =
    body.detail === null
      ? undefined
      : describeToolInput(body.detail)
          .split('\n')
          .find((text) => text.trim())
  const input = normalizeOptionalField(line, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  return input ? { tool, input } : { tool }
}
