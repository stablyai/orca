import { connectorMessageShownText } from './connector-asker-prompt'
import { slackMarkupShownText } from './connectors/slack-message-markup'
import type { NativeChatBlock } from './native-chat/native-chat-types'
import { nativeChatProseToMarkdown } from './native-chat/transcript/row-content/native-chat-prose'

type ShownMessage = {
  role: string
  blocks: NativeChatBlock[]
  origin?: string
  asker?: { source?: string }
}

const SENT_LINE = /^\[Orca: sent [^\n\]]+\]\n/
const ASKED_BY =
  /^\[Orca: [^\n]*? · from ([^\n]+?)(?: \(your owner\)|, who has access \(not your owner\)|, another app your owner lets ask you)/

/** Show the sender's words and keep the images, including on recovered requests. */
export function connectorMessageShown(
  { role, blocks, origin, asker }: ShownMessage,
  drawMarkdown = true
): {
  blocks: NativeChatBlock[]
  drawnMarkdown?: string
} {
  if (origin !== 'connector' || role !== 'user') {
    return { blocks }
  }
  let changed = false
  const markdown = drawMarkdown ? new Map<NativeChatBlock, NativeChatBlock>() : undefined
  const own = blocks.findLastIndex((block) => block.type === 'text')
  const projected = blocks.map((block, index) => {
    if (block.type !== 'text') {
      return block
    }
    const text = block.text.replace(SENT_LINE, '')
    const shown = connectorMessageShownText(text)
    if (shown === null) {
      return block
    }
    changed = true
    // A failed request carries its own sender; the message's tag names only the latest requester.
    const author = index === own ? undefined : ASKED_BY.exec(text)?.[1]
    const words = author ? `${author}\n\n${shown}` : shown
    const slack = asker?.source === 'slack' ? slackMarkupShownText(words) : null
    const shownBlock = { ...block, text: slack?.text ?? words }
    if (markdown && slack) {
      markdown.set(shownBlock, { ...block, text: slack.markdown })
    }
    return shownBlock
  })
  if (!changed) {
    return { blocks }
  }
  return {
    blocks: projected,
    ...(markdown?.size
      ? {
          drawnMarkdown: nativeChatProseToMarkdown(
            projected.map((block) => markdown.get(block) ?? block)
          )
        }
      : {})
  }
}

export function connectorMessageShownBlocks(message: ShownMessage): NativeChatBlock[] {
  return connectorMessageShown(message, false).blocks
}
