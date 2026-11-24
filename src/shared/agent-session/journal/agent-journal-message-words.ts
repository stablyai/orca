// A person's message as an agent reads its words, and whether those words must open the prompt.
import type { AgentJournalMessageItem } from './agent-session-journal-types'

/** A command or goal, or words starting with a slash command, which only work at the prompt start:
 *  nothing may go ahead of them. */
export function isPromptCommand(body: AgentJournalMessageItem): boolean {
  if (body.command !== undefined || body.sentAs !== undefined) {
    return true
  }
  const firstText = body.blocks.find((block) => block.type === 'text' && block.text.length > 0)
  return firstText?.type === 'text' && firstText.text.startsWith('/')
}

/** A message's words as an agent joins its text blocks. */
export function messageWords(body: AgentJournalMessageItem): string {
  return body.blocks
    .flatMap((block) => (block.type === 'text' && block.text.length > 0 ? [block.text] : []))
    .join('\n')
}
