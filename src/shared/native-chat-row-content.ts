// Share renderability with transcript windowing or invisible rows reserve empty slots.
// Cache by block-array revision so streaming consumers derive content once per frame.

import { backgroundTaskBlocks, claimBackgroundTaskTwins } from './native-chat-background-task-row'
import { isWordlessProviderFrameBlock } from './native-chat/native-chat-provider-frame-summary'
import { isReplacedSubagentGroupTwin, subagentGroupBlocks } from './native-chat-subagent-summary'
import {
  isBackgroundTaskBlock,
  isSubagentGroupBlock,
  type NativeChatBlock
} from './native-chat-types'
import { splitNativeChatBlocks } from './native-chat/tools/native-chat-tool-fold'
import { nativeChatProseToMarkdown } from './native-chat-prose'

/** Inferred from `derive` so the shape cannot drift from what it returns. */
export type NativeChatRowContent = ReturnType<typeof derive>

const derivations = new WeakMap<object, NativeChatRowContent>()

function derive(blocks: readonly NativeChatBlock[]) {
  const split = splitNativeChatBlocks(
    blocks.filter((block) => !isWordlessProviderFrameBlock(block))
  )
  const groups = subagentGroupBlocks(split.prose)
  const tasks = backgroundTaskBlocks(split.prose)
  // Remove fallback twins only when rendering their blocks; preserve real adjacent prose. Task twins need exact matching because provider sentences have no stable shape.
  const taskTwins = claimBackgroundTaskTwins(split.prose)
  const prose =
    groups.length === 0 && tasks.length === 0
      ? split.prose
      : split.prose.filter(
          (block, index) =>
            !isSubagentGroupBlock(block) &&
            !isBackgroundTaskBlock(block) &&
            !taskTwins.twinTextIndexes.has(index) &&
            !isReplacedSubagentGroupTwin(block, groups.length > 0)
        )
  return {
    prose,
    tools: split.tools,
    subagentGroups: groups,
    backgroundTasks: tasks,
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
  const { markdown, hasImages, tools, subagentGroups, backgroundTasks } =
    deriveNativeChatRowContent(blocks)
  return (
    markdown.length > 0 ||
    hasImages ||
    tools.length > 0 ||
    subagentGroups.length > 0 ||
    backgroundTasks.length > 0
  )
}
