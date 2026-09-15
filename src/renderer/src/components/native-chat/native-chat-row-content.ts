// One derivation of a message's renderable parts, shared by the row that draws it
// and the list that decides whether it occupies a transcript slot. Windowing makes
// that agreement load-bearing: a row the list counts but the row component declines
// to draw would reserve estimated height for nothing.
//
// Cached on the block array itself, so a streaming turn re-deriving on every frame
// pays once per revision rather than once per consumer.

import {
  isSubagentGroupFallbackText,
  subagentGroupBlocks
} from '../../../../shared/native-chat-subagent-summary'
import { isSubagentGroupBlock, type NativeChatBlock } from '../../../../shared/native-chat-types'
import { splitNativeChatBlocks } from './native-chat-tool-fold'
import { nativeChatProseToMarkdown } from './native-chat-prose'

/** Inferred from `derive` so the shape cannot drift from what it returns. */
export type NativeChatRowContent = ReturnType<typeof derive>

const derivations = new WeakMap<object, NativeChatRowContent>()

function derive(blocks: readonly NativeChatBlock[]) {
  const split = splitNativeChatBlocks(blocks)
  const groups = subagentGroupBlocks(split.prose)
  // A spawn-group row carries a plain-text twin so a client without the block type
  // still reads the roster. This draws the block, so only the twin is dropped —
  // never real text beside it, which a lane folding a roster into a message keeps.
  const prose =
    groups.length === 0
      ? split.prose
      : split.prose.filter(
          (block) =>
            !isSubagentGroupBlock(block) &&
            !(block.type === 'text' && isSubagentGroupFallbackText(block.text))
        )
  return {
    prose,
    tools: split.tools,
    subagentGroups: groups,
    markdown: nativeChatProseToMarkdown(prose),
    hasImages: prose.some((block) => block.type === 'image-ref')
  }
}

export function deriveNativeChatRowContent(
  blocks: readonly NativeChatBlock[]
): NativeChatRowContent {
  const cached = derivations.get(blocks)
  if (cached) {
    return cached
  }
  const content = derive(blocks)
  derivations.set(blocks, content)
  return content
}

/** Whether the row draws anything. An empty row takes no slot in the transcript. */
export function nativeChatRowRendersContent(blocks: readonly NativeChatBlock[]): boolean {
  const { markdown, hasImages, tools, subagentGroups } = deriveNativeChatRowContent(blocks)
  return markdown.length > 0 || hasImages || tools.length > 0 || subagentGroups.length > 0
}
