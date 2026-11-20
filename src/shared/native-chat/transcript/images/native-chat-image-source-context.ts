import {
  agentImageSourceContexts,
  type AgentImageSourceContextRange
} from '../../input/composer/agent-image-paste'
import { isImageRefBlock, isTextBlock, type NativeChatBlock } from '../../native-chat-types'

export function withoutAgentImageSourceContexts(blocks: NativeChatBlock[]): NativeChatBlock[] {
  const images = blocks.filter(isImageRefBlock)
  const contexts = blocks.flatMap((block, index) =>
    isTextBlock(block)
      ? [...agentImageSourceContexts(block.text)].map((context) => ({ ...context, index }))
      : []
  )
  const selected = new Map<number, AgentImageSourceContextRange[]>()
  const select = (context: (typeof contexts)[number]) => {
    const ranges = selected.get(context.index) ?? []
    ranges.unshift(context)
    selected.set(context.index, ranges)
  }
  if (images.length) {
    let remaining = images.length
    for (let index = contexts.length - 1; index >= 0 && remaining > 0; index--) {
      const context = contexts[index]
      const first = remaining - context.delivered.length
      if (
        first >= 0 &&
        context.delivered.every(
          (path, offset) => !images[first + offset].path || images[first + offset].path === path
        )
      ) {
        select(context)
        remaining = first
      }
    }
    if (remaining > 0) {
      return blocks
    }
  } else {
    for (let index = contexts.length - 1; index >= 0; index--) {
      const context = contexts[index]
      const block = blocks[context.index]
      if (!isTextBlock(block)) {
        continue
      }
      const before = block.text.slice(0, context.start).trimEnd()
      if (
        [context.delivered.join(' '), context.delivered.join('')].some(
          (prefix) => prefix && (before === prefix || before.endsWith(` ${prefix}`))
        )
      ) {
        select(context)
      }
    }
  }
  if (selected.size === 0) {
    return blocks
  }
  return blocks.flatMap((block, index): NativeChatBlock[] => {
    const ranges = selected.get(index)
    if (!isTextBlock(block) || !ranges) {
      return [block]
    }
    let text = ''
    let cursor = 0
    for (const range of ranges) {
      text += block.text.slice(cursor, range.start)
      cursor = range.end
    }
    text += block.text.slice(cursor)
    if (!block.text.slice(0, ranges[0].start).trim()) {
      text = text.trimStart()
    }
    if (ranges.at(-1)?.end === block.text.length) {
      text = text.trimEnd()
    }
    return text.trim() ? [{ ...block, text }] : []
  })
}
