// How a subagent's view ends: only a completed subagent gets a reply; anything else says why it has none.

import type {
  NativeChatMessage,
  NativeChatSubagentEntry
} from '../../../../../shared/native-chat/native-chat-types'
import { normalizeSubagentState } from '../../../../../shared/native-chat/transcript/native-chat-subagent-summary'
import type { NativeChatSubagentHandoff } from './native-chat-subagent-handoff'
import type { NativeChatSubagentHistory } from './native-chat-subagent-history'

/** A quiet line in the transcript's notice style. */
export type NativeChatSubagentAside = 'no-steps' | 'cleared' | 'stopped' | 'no-reply'

export type NativeChatSubagentEnding =
  | { kind: 'reply'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'aside'; aside: NativeChatSubagentAside }
  | null

function words(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Codex's last own message is its reply; a clipped copy of it counts as the same. */
function rowsEndWith(rows: readonly NativeChatMessage[], reply: string): boolean {
  const last = rows.findLast((row) => row.role === 'assistant')
  const said = words(
    last?.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n') ?? ''
  )
  const replied = words(reply)
  return said.length > 0 && (said.startsWith(replied) || replied.startsWith(said))
}

export function nativeChatSubagentEnding({
  entry,
  handoff,
  rows,
  history
}: {
  entry: NativeChatSubagentEntry | undefined
  handoff: NativeChatSubagentHandoff | null
  /** The subagent's own rows. */
  rows: readonly NativeChatMessage[]
  history: NativeChatSubagentHistory
}): NativeChatSubagentEnding {
  if (rows.length === 0 && history === 'cleared') {
    return { kind: 'aside', aside: 'cleared' }
  }
  const state = entry === undefined ? null : normalizeSubagentState(entry.state)
  switch (state) {
    case 'completed': {
      const reply = handoff?.reply ?? entry?.lastMessage?.trim()
      if (reply && rowsEndWith(rows, reply)) {
        return null
      }
      return reply ? { kind: 'reply', text: reply } : { kind: 'aside', aside: 'no-reply' }
    }
    case 'failed': {
      const error = handoff?.error ?? entry?.lastMessage?.trim()
      return error ? { kind: 'error', text: error } : { kind: 'aside', aside: 'no-reply' }
    }
    case 'stopped':
      return { kind: 'aside', aside: 'stopped' }
    case 'unverifiable':
      return { kind: 'aside', aside: 'no-reply' }
    case 'working':
    case 'idle':
    case null:
      return rows.length === 0 ? { kind: 'aside', aside: 'no-steps' } : null
  }
}

/** The ending as the view's last row: the reply as the agent's message, the rest as notices. */
export function nativeChatSubagentEndingMessage(
  agentId: string,
  ending: Exclude<NativeChatSubagentEnding, null>,
  asideText: string,
  settledAt: number | undefined
): NativeChatMessage {
  const base = {
    id: `subagent-ending:${agentId}`,
    timestamp: settledAt ?? null,
    source: 'transcript'
  } as const
  switch (ending.kind) {
    case 'reply':
      return { ...base, role: 'assistant', blocks: [{ type: 'text', text: ending.text }] }
    case 'error':
      return {
        ...base,
        role: 'system',
        blocks: [{ type: 'text', text: ending.text, tone: 'error' }]
      }
    case 'aside':
      return { ...base, role: 'system', blocks: [{ type: 'text', text: asideText }] }
  }
}
