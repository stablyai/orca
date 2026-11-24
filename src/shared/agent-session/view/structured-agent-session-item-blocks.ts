import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import type { NativeChatBlock, NativeChatMessage } from '../../native-chat/native-chat-types'
import { agentJournalToolCallLifecycle } from '../journal/agent-journal-tool-call-lifecycle'
import { connectorMessageShown } from '../../connector-asker-prompt'
import { structuredAgentSessionStatusBlock } from './structured-agent-session-status-block'
import {
  isStructuredAgentSessionToolAction,
  structuredAgentSessionToolCallBlock
} from './messages/structured-agent-session-tool-call-block'

/** Only transport-clipped output has a fetchable remainder; older saved truncations have none. */
function toolResult(
  item: AgentJournalRenderItem,
  payload: { head: string; truncated: boolean; byteLength: number },
  callId: string | undefined
) {
  return {
    type: 'tool-result' as const,
    output: payload.truncated ? `${payload.head}\n… (${payload.byteLength} bytes)` : payload.head,
    callId,
    ...(item.shortened && payload.truncated ? { fullOutputItemId: item.itemId } : {})
  }
}

export function itemBlocks(item: AgentJournalRenderItem): {
  role: NativeChatMessage['role']
  blocks: NativeChatBlock[]
  drawnMarkdown?: string
} | null {
  const body = item.body
  if (body.kind === 'message') {
    return { role: body.role, ...connectorMessageShown(body) }
  }
  if (isStructuredAgentSessionToolAction(body)) {
    const call = structuredAgentSessionToolCallBlock(body, item.itemId)
    // Call/result share one row; use its call ID to pair them.
    if (body.kind === 'diff') {
      return { role: 'assistant', blocks: [call, toolResult(item, body.patch, call.callId)] }
    }
    return {
      role: 'assistant',
      blocks: [
        call,
        ...(body.output
          ? [
              {
                ...toolResult(item, body.output, call.callId),
                // Interrupted output is not an error reported by the tool.
                isError: agentJournalToolCallLifecycle(body) === 'failed'
              }
            ]
          : [])
      ]
    }
  }
  if (body.kind === 'approval') {
    if (body.resolution.state === 'pending') {
      return null
    }
    return {
      role: 'system',
      blocks: [
        {
          type: 'text',
          text: `${body.title}\n${body.detail ?? ''}\n${body.resolution.state}`.trim()
        }
      ]
    }
  }
  if (body.kind === 'question') {
    if (body.resolution.state === 'pending') {
      return null
    }
    const choices = body.options.map((option) => option.label).join(' · ')
    return {
      role: 'system',
      blocks: [{ type: 'text', text: `${body.question}\n${choices}`.trim() }]
    }
  }
  // Turn records are timing only; unknown newer-host kinds must not become text.
  if (body.kind !== 'status' || body.turnLifecycle) {
    return null
  }
  return {
    role: 'system',
    blocks: [structuredAgentSessionStatusBlock(body, item.turnScope, item.itemId)]
  }
}
