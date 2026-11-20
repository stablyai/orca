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
    const known = new Map<string, number[]>()
    const unknown: number[] = []
    images.forEach((image, index) => {
      if (image.path) {
        const indices = known.get(image.path) ?? []
        indices.push(index)
        known.set(image.path, indices)
      } else {
        unknown.push(index)
      }
    })
    for (let index = contexts.length - 1; index >= 0; index--) {
      const context = contexts[index]
      const block = blocks[context.index]
      if (!isTextBlock(block)) {
        continue
      }
      const edge =
        unknown.length > 0 &&
        (context.end === block.text.length || !block.text.slice(0, context.start).trim())
      const matched: { queue: number[]; image: number }[] = []
      for (const path of context.delivered) {
        const candidates = known.get(path)
        const queue = candidates ?? (edge ? unknown : undefined)
        const image = queue?.pop()
        if (queue && image !== undefined) {
          matched.push({ queue, image })
        } else {
          break
        }
      }
      if (matched.length === context.delivered.length) {
        select(context)
      } else {
        for (let offset = matched.length - 1; offset >= 0; offset--) {
          matched[offset].queue.push(matched[offset].image)
        }
      }
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
