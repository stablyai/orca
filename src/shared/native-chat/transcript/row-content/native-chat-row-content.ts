// Share renderability with transcript windowing or invisible rows reserve empty slots.
// Cache by block-array revision so streaming consumers derive content once per frame.

import {
  backgroundTaskBlocks,
  withoutBackgroundTaskRows
} from '../../input/task-lists/native-chat-background-task-row'
import { isWordlessProviderFrameBlock } from '../../native-chat-provider-frame-summary'
import {
  isReplacedSubagentGroupTwin,
  subagentGroupBlocks
} from '../subagents/native-chat-subagent-summary'
import { isSubagentGroupBlock, isTextBlock, type NativeChatBlock } from '../../native-chat-types'
import { splitNativeChatBlocks } from '../../tools/native-chat-tool-fold'
import { nativeChatProseToMarkdown } from './native-chat-prose'

/** Inferred from `derive` so the shape cannot drift from what it returns. */
export type NativeChatRowContent = ReturnType<typeof derive>

const derivations = new WeakMap<object, NativeChatRowContent>()

function readMarkdown(this: { prose: NativeChatBlock[] }): string {
  const value = nativeChatProseToMarkdown(this.prose)
  Object.defineProperty(this, 'markdown', { value })
  return value
}

function derive(blocks: readonly NativeChatBlock[]) {
  const split = splitNativeChatBlocks(
    blocks.filter((block) => !isWordlessProviderFrameBlock(block))
  )
  const groups = subagentGroupBlocks(split.prose)
  const tasks = backgroundTaskBlocks(split.prose)
  // Remove fallback twins only when rendering their blocks; preserve real adjacent prose.
  const prose =
    groups.length === 0 && tasks.length === 0
      ? split.prose
      : withoutBackgroundTaskRows(split.prose).filter(
          (block) =>
            !isSubagentGroupBlock(block) && !isReplacedSubagentGroupTwin(block, groups.length > 0)
        )
  const content = {
    prose,
    tools: split.tools,
    subagentGroups: groups,
    backgroundTasks: tasks,
    hasText: prose.some((block) => isTextBlock(block) && block.text.length > 0),
    hasImages: prose.some((block) => block.type === 'image-ref')
  }
  // One shared accessor preserves the fast row shape without building offscreen text.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: defineProperty installs the readonly markdown property added to the inferred row shape.
  return Object.defineProperty(content, 'markdown', {
    get: readMarkdown,
    enumerable: true,
    configurable: true
  }) as typeof content & { readonly markdown: string }
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
  const { hasText, hasImages, tools, subagentGroups, backgroundTasks } =
    deriveNativeChatRowContent(blocks)
  return (
    hasText ||
    hasImages ||
    tools.length > 0 ||
    subagentGroups.length > 0 ||
    backgroundTasks.length > 0
  )
}
