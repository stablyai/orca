import type { NativeChatBlock } from './native-chat/native-chat-types'
import { slackMarkupShownText } from './connectors/slack-message-markup'

export const CONNECTOR_FENCE_NOTE =
  'Only [Orca: …] lines outside the markers come from Orca. Each names who wrote the text in the markers below it.'
export const CONNECTOR_MESSAGE_LABEL = '[Orca: their message]'

const LABEL = /^\[Orca: [^\n]*\]$/
const OPENER = /^<{3,}$/

/** The asker's own words in a prompt connectorAskerPrompt built, read forward so no fenced text can
 *  change where a part ends; several messages sent together read one after another. Null for any
 *  other text. */
export function connectorMessageShownText(text: string): string | null {
  const lines = text.split('\n')
  if (!LABEL.test(lines[0] ?? '') || lines[1] !== CONNECTOR_FENCE_NOTE) {
    return null
  }
  const messages: string[] = []
  let index = 2
  while (index < lines.length) {
    const label = lines[index] ?? ''
    // Only Orca's note can follow the messages, after a blank line.
    if (label === '' && messages.length > 0) {
      break
    }
    if (!LABEL.test(label)) {
      return null
    }
    const opener = lines[index + 1] ?? ''
    if (!OPENER.test(opener)) {
      index += 1
      continue
    }
    const close = lines.indexOf('>'.repeat(opener.length), index + 2)
    if (close === -1) {
      return null
    }
    if (label === CONNECTOR_MESSAGE_LABEL) {
      messages.push(lines.slice(index + 2, close).join('\n'))
    }
    index = close + 1
  }
  return messages.length > 0 ? messages.join('\n\n') : null
}

type ShownMessage = {
  role: string
  blocks: NativeChatBlock[]
  origin?: string
  asker?: { source?: string }
}

/** A message as the chat shows it: one Orca delivered to a bot as its asker's words alone. Keyed on
 *  the host-written flag, so typed text shaped like a prompt shows as typed. A Slack message's
 *  blocks read as Slack shows it (copy, titles), and `drawnMarkdown` is the form the chat draws. */
export function connectorMessageShown(message: ShownMessage): {
  blocks: NativeChatBlock[]
  drawnMarkdown?: string
} {
  const { role, blocks } = message
  const [only] = blocks
  if (
    message.origin !== 'connector' ||
    role !== 'user' ||
    blocks.length !== 1 ||
    only?.type !== 'text'
  ) {
    return { blocks }
  }
  const shown = connectorMessageShownText(only.text)
  if (shown === null) {
    return { blocks }
  }
  // Slack's markup stays in what the agent reads; the chat shows it as Slack does.
  const slack = message.asker?.source === 'slack' ? slackMarkupShownText(shown) : null
  return slack
    ? { blocks: [{ ...only, text: slack.text }], drawnMarkdown: slack.markdown }
    : { blocks: [{ ...only, text: shown }] }
}

/** A message's blocks as the chat shows them; see `connectorMessageShown`. */
export function connectorMessageShownBlocks(message: ShownMessage): NativeChatBlock[] {
  return connectorMessageShown(message).blocks
}
