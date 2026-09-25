// The newest messages a session list quotes for a session: its own user's prompt and its own
// agent's prose, never a subagent's rows that share the journal.

import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import type { NativeChatBlock } from './native-chat-types'

function messageProse(blocks: readonly NativeChatBlock[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** The newest prompt the session's own user turn carries, as the sidebar quotes
 *  it. Scoped to root rows for the same reason the assistant line is: a provider
 *  that journals a subagent's own prompt would otherwise requote it as the
 *  session's. */
export function latestStructuredAgentSessionPrompt(
  items: readonly AgentJournalRenderItem[]
): string {
  const body = latestStructuredAgentSessionUserItem(items)?.body
  return body?.kind === 'message' ? messageProse(body.blocks) : ''
}

export function latestStructuredAgentSessionUserItem(
  items: readonly AgentJournalRenderItem[]
): AgentJournalRenderItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (
      item?.body.kind === 'message' &&
      item.body.role === 'user' &&
      isRootAgentJournalItem(item)
    ) {
      return item
    }
  }
  return null
}

/** The newest prose THE SESSION'S OWN AGENT wrote in the latest user turn — not a
 *  subagent's, whose rows share this journal and are usually the newer ones while
 *  a child runs. Tool-only assistant items are skipped; the user boundary clears
 *  prose from the preceding turn. */
export function latestStructuredAgentSessionAssistantMessage(
  items: readonly AgentJournalRenderItem[]
): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    const body = item?.body
    if (!isRootAgentJournalItem(item)) {
      continue
    }
    if (body?.kind === 'message' && body.role === 'user') {
      return ''
    }
    if (body?.kind === 'message' && body.role === 'assistant') {
      const prose = messageProse(body.blocks)
      if (prose.trim()) {
        return prose
      }
    }
  }
  return ''
}
