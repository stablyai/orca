import {
  AGENT_JOURNAL_MESSAGE_SEND_MODES,
  AGENT_JOURNAL_MESSAGE_STATES,
  type AgentJournalMessageItem,
  type AgentJournalMessageSendMode,
  type AgentJournalRenderItem
} from '../journal/agent-session-journal-types'

import { agentJournalToolCallLifecycle } from '../../agent-journal-tool-call-lifecycle'
import { agentJournalLinkageFields } from '../journal/agent-session-journal-producer'
import { structuredAgentSessionStatusBlock } from './structured-agent-session-status-block'
import { agentJournalItemRowOrigin } from '../journal/agent-session-journal-position'

import {
  isStructuredAgentSessionToolAction,
  structuredAgentSessionToolCallBlock
} from '../structured-agent-session-tool-call-block'
import type { NativeChatBlock, NativeChatMessage } from '../../native-chat/native-chat-types'

import { readAgentMessageSource } from '../agent-session-message-source'

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

const BOUNDED_TEXT_MARKERS = [
  /\n\u2026 \(\d+ bytes\)$/,
  /\n\[Orca: output truncated \u2014 \d+ bytes total, digest [0-9a-f]+\]$/
]

export function stripBoundedTextMarker(text: string): { text: string; truncated: boolean } {
  const stripped = BOUNDED_TEXT_MARKERS.reduce((value, marker) => value.replace(marker, ''), text)
  return { text: stripped, truncated: stripped.length !== text.length }
}

function itemBlocks(item: AgentJournalRenderItem): {
  role: NativeChatMessage['role']
  blocks: NativeChatBlock[]
} | null {
  const body = item.body
  if (body.kind === 'message') {
    return { role: body.role, blocks: body.blocks }
  }
  if (isStructuredAgentSessionToolAction(body)) {
    const call = structuredAgentSessionToolCallBlock(body, item.itemId)
    // Call/result share one row; use its call ID to pair them.
    const { callId } = call
    if (body.kind === 'diff') {
      return { role: 'assistant', blocks: [call, toolResult(item, body.patch, callId)] }
    }
    return {
      role: 'assistant',
      blocks: [
        call,
        ...(body.output
          ? [
              {
                ...toolResult(item, body.output, callId),
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

function isAgentJournalMessageSendMode(value: string): value is AgentJournalMessageSendMode {
  return AGENT_JOURNAL_MESSAGE_SEND_MODES.some((mode) => mode === value)
}

function messageLifecycle(
  body: AgentJournalMessageItem
): Pick<NativeChatMessage, 'state' | 'completedAt'> {
  const state: string | undefined = body.state
  if (state === undefined) {
    return {}
  }
  return {
    state: AGENT_JOURNAL_MESSAGE_STATES.find((known) => known === state) ?? 'completed',
    ...(body.completedAt !== undefined ? { completedAt: body.completedAt } : {})
  }
}

const projectedItems = new WeakMap<AgentJournalRenderItem, NativeChatMessage | null>()

export function projectStructuredItemsToNativeChat(
  items: readonly AgentJournalRenderItem[]
): NativeChatMessage[] {
  const messages: NativeChatMessage[] = []
  items.forEach((item) => {
    const projected = projectStructuredItemToNativeChat(item)
    if (projected) {
      messages.push(projected)
    }
  })
  return messages
}

export function projectStructuredItemToNativeChat(
  item: AgentJournalRenderItem
): NativeChatMessage | null {
  const cached = projectedItems.get(item)
  if (cached !== undefined) {
    return cached
  }
  // Reducer updates replace journal items, so unchanged rows keep their render caches.
  const projected = itemBlocks(item)
  const sentAs = item.body.kind === 'message' ? item.body.sentAs : undefined
  const lifecycle = item.body.kind === 'message' ? messageLifecycle(item.body) : {}
  const command = item.body.kind === 'message' ? item.body.command : undefined
  // Validate wire-origin sender fields from any host version.
  const from = item.body.kind === 'message' ? readAgentMessageSource(item.body.from) : undefined
  const message: NativeChatMessage | null = projected
    ? {
        ...agentJournalItemRowOrigin(item),
        ...agentJournalLinkageFields(item),
        role: projected.role,
        blocks: projected.blocks,
        // A send mode this build cannot name renders as an ordinary message.
        ...(sentAs !== undefined && isAgentJournalMessageSendMode(sentAs) ? { sentAs } : {}),
        ...lifecycle,
        ...(command ? { command } : {}),
        ...(from && projected.role === 'user' ? { from } : {}),
        ...(item.shortened && item.body.kind === 'message' ? { shortened: true } : {})
      }
    : null
  projectedItems.set(item, message)
  return message
}
