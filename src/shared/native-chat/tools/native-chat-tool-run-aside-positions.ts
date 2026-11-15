import type { NativeChatBlock } from '../native-chat-types'

export function nativeChatToolRunAsidePositions<T>(
  blocks: readonly NativeChatBlock[],
  before: ReadonlyMap<NativeChatBlock, readonly T[]> | undefined,
  after: readonly T[] | undefined
): ReadonlyMap<number, readonly T[]> {
  const positions = new Map<number, readonly T[]>()
  for (const [index, block] of blocks.entries()) {
    const items = before?.get(block)
    if (items?.length) {
      positions.set(index, items)
    }
  }
  if (after?.length) {
    positions.set(blocks.length, after)
  }
  return positions
}
