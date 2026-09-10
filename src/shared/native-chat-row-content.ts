import {
  isSubagentGroupBlock,
  isTextBlock,
  type NativeChatBlock,
  type NativeChatMessage,
  type NativeChatSubagentGroupBlock
} from './native-chat-types'
import { isSubagentGroupFallbackText, subagentGroupBlocks } from './native-chat-subagent-summary'
import { splitNativeChatBlocks } from './native-chat-tool-fold'

export function nativeChatProseToMarkdown(blocks: readonly NativeChatBlock[]): string {
  return blocks
    .map((block) => (isTextBlock(block) ? block.text : ''))
    .filter((part) => part.length > 0)
    .join('\n\n')
}

/** What a transcript row actually draws, split the way the row draws it.
 *
 *  A spawn-group row carries a plain-text twin so a client without the block type still reads the
 *  roster; a client that draws the block drops the twin rather than printing both. */
export function nativeChatRowContent(blocks: readonly NativeChatBlock[]): {
  prose: NativeChatBlock[]
  tools: NativeChatBlock[]
  subagentGroups: NativeChatSubagentGroupBlock[]
} {
  const split = splitNativeChatBlocks(blocks)
  const groups = subagentGroupBlocks(split.prose)
  return {
    tools: split.tools,
    subagentGroups: groups,
    prose:
      groups.length === 0
        ? split.prose
        : split.prose.filter(
            (block) =>
              !isSubagentGroupBlock(block) &&
              !(block.type === 'text' && isSubagentGroupFallbackText(block.text))
          )
  }
}

/**
 * Whether the transcript draws its hover control cluster on this row.
 *
 * The fork action lives in that cluster, so this is also the only place a fork control can appear:
 * anything anchored elsewhere silently renders nothing. Kept beside the row's own derivation rather
 * than approximated, because an approximation is exactly how a turn loses its only affordance —
 * a row whose blocks are all tool activity, all images, or a provider frame draws no prose and so
 * draws no controls.
 */
export function nativeChatMessageDrawsAgentControls(message: NativeChatMessage | null): boolean {
  if (message?.role !== 'assistant') {
    return false
  }
  if (message.blocks.some((block) => block.type === 'text' && block.providerFrame)) {
    return false
  }
  return nativeChatProseToMarkdown(nativeChatRowContent(message.blocks).prose).length > 0
}
