import type { AgentJournalMessageItem } from './agent-session-journal-types'
import { MAX_PROMPT_BYTES } from './rpc-contract/structured-agent-session-params'

/** The text an in-place edit starts from, or null when the card is not editable: a command is
 *  not a draft, and a block this edit cannot carry over unchanged refuses rather than drops. */
export function queuedMessageEditableText(body: AgentJournalMessageItem): string | null {
  if (body.command || body.blocks.some((b) => b.type !== 'text' && b.type !== 'image-ref')) {
    return null
  }
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** The body with its text replaced by one block at the first text block's place; attachments,
 *  sender, kind and send mode stay. Null when the result would not be a sendable draft. */
export function queuedMessageWithEditedText(
  body: AgentJournalMessageItem,
  text: string
): AgentJournalMessageItem | null {
  if (
    queuedMessageEditableText(body) === null ||
    new TextEncoder().encode(text).length > MAX_PROMPT_BYTES ||
    (!text.trim() && !body.blocks.some((block) => block.type === 'image-ref'))
  ) {
    return null
  }
  // Unchanged text keeps its blocks, so a Save that changes nothing is a no-op.
  if (text === queuedMessageEditableText(body)) {
    return body
  }
  const blocks: AgentJournalMessageItem['blocks'] = []
  let placed = false
  for (const block of body.blocks) {
    if (block.type !== 'text') {
      blocks.push(block)
    } else if (!placed) {
      blocks.push({ type: 'text', text })
      placed = true
    }
  }
  if (!placed) {
    blocks.unshift({ type: 'text', text })
  }
  return { ...body, blocks }
}
