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

/** Show the sender's words and keep the images, including on recovered requests. */
export function connectorMessageShown({ role, blocks, origin, asker }: ShownMessage): {
  blocks: NativeChatBlock[]
  drawnMarkdown?: string
} {
  if (origin !== 'connector' || role !== 'user') {
    return { blocks }
  }
  let changed = false
  const markdown = new Map<NativeChatBlock, NativeChatBlock>()
  const projected = blocks.map((block) => {
    if (block.type !== 'text') {
      return block
    }
    const text = block.text.replace(/^\[Orca: sent [^\n\]]+\]\n/, '')
    const shown = connectorMessageShownText(text)
    if (shown === null) {
      return block
    }
    changed = true
    const slack = asker?.source === 'slack' ? slackMarkupShownText(shown) : null
    const shownBlock = { ...block, text: slack?.text ?? shown }
    if (slack) {
      markdown.set(shownBlock, { ...block, text: slack.markdown })
    }
    return shownBlock
  })
  if (!changed) {
    return { blocks }
  }
  return {
    blocks: projected,
    ...(markdown.size > 0
      ? {
          drawnMarkdown: nativeChatProseToMarkdown(
            projected.map((block) => markdown.get(block) ?? block)
          )
        }
      : {})
  }
}

export function connectorMessageShownBlocks(message: ShownMessage): NativeChatBlock[] {
  return connectorMessageShown(message).blocks
}
