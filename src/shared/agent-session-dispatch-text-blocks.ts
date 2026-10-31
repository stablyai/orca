import type { NativeChatBlock } from './native-chat-types'

/** Keep block boundaries from changing prompt text in transports that concatenate without separators. */
export function joinAdjacentAgentTextBlocks(blocks: readonly NativeChatBlock[]): NativeChatBlock[] {
  const joined: NativeChatBlock[] = []
  for (const block of blocks) {
    const previous = joined.at(-1)
    if (block.type === 'text' && previous?.type === 'text') {
      previous.text += `\n${block.text}`
    } else {
      joined.push(block.type === 'text' ? { ...block } : block)
    }
  }
  return joined
}
