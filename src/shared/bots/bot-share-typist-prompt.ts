// What a bot's agent reads of a message a shared teammate typed in Orca.
import type { AgentJournalMessageItem } from '../agent-session/journal/agent-session-journal-types'
import { shareTypistOf } from '../agent-session/journal/agent-journal-typed-by'
import {
  isPromptCommand,
  messageWords
} from '../agent-session/lifecycle/stopping/agent-session-stopped-history'
import { MESSAGE_LABEL, NOTE, shownName } from '../connector-asker-prompt'
import { fenceQuotedText } from '../quoted-text-fence'

/** A shared teammate's message typed in Orca, as its agent reads it: Orca's line naming them from
 *  their share row, then their words fenced as a connector message's are, ahead of any files. A
 *  command keeps its prompt start; the turn's checks read the stamp, not this text. */
export function withShareTypistPrompt(body: AgentJournalMessageItem): AgentJournalMessageItem {
  const typist = shareTypistOf(body.typedBy)
  if (!typist || isPromptCommand(body)) {
    return body
  }
  const header = `[Orca: Orca app · from ${shownName(typist.name) ?? 'a teammate'}, who has access (not your owner)]`
  const words = messageWords(body)
  const text = words ? [header, NOTE, MESSAGE_LABEL, fenceQuotedText(words)].join('\n') : header
  return {
    ...body,
    blocks: [{ type: 'text', text }, ...body.blocks.filter((block) => block.type !== 'text')]
  }
}
