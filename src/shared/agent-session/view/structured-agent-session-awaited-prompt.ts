import type { AgentSessionStatusSummary } from '../agent-session-wire'
import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { approvalRecordTool } from '../requests/prompts/agent-session-approval-tool'
import { describeToolInput } from '../../native-chat/tools/native-chat-tool-summary'
import {
  AGENT_STATUS_MAX_FIELD_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  normalizeOptionalField
} from '../../agent-status/contracts/agent-status-field-normalization'
import { AGENT_STATUS_TOOL_NAME_MAX_LENGTH } from '../../agent-status/contracts/agent-status-types'

/** What the prompts waiting on the person ask, so a list can say it without the chat's rows:
 *  the first one's approval tool and command line, or question text, and whether all are questions. */
export function structuredAgentSessionAwaitedPrompt(
  pending: readonly AgentJournalRenderItem[]
): Pick<
  AgentSessionStatusSummary,
  'awaitsApproval' | 'awaitsBlockingQuestion' | 'attentionAsksOnlyQuestions'
> {
  const first = pending[0]
  if (first?.body.kind === 'question') {
    const text = normalizeOptionalField(first.body.question, AGENT_STATUS_MAX_FIELD_LENGTH)
    return {
      ...(text ? { awaitsBlockingQuestion: { text } } : {}),
      ...(pending.every((item) => item.body.kind === 'question')
        ? { attentionAsksOnlyQuestions: true as const }
        : {})
    }
  }
  if (first?.body.kind !== 'approval') {
    return {}
  }
  const { body } = first
  const tool = normalizeOptionalField(
    approvalRecordTool(body.toolName, body.displayName ?? body.title),
    AGENT_STATUS_TOOL_NAME_MAX_LENGTH
  )
  if (!tool) {
    return {}
  }
  // As the working status names a tool's input: its command, file or URL, not the JSON around it.
  const line =
    body.detail === null
      ? undefined
      : describeToolInput(body.detail)
          .split('\n')
          .find((text) => text.trim())
  const input = normalizeOptionalField(line, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  return { awaitsApproval: input ? { tool, input } : { tool } }
}
