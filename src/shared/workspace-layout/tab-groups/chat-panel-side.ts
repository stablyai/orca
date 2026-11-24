// Chat column placement both the window and the runtime owner apply: the mode
// toggle sends it as a command, so the swap lives here instead of in store code.
import type { TabGroupLayoutNode } from './tab-types'

export type ChatPanelSide = 'first' | 'second'

/** Swaps horizontal splits so the chat subtree sits on `side`; vertical splits keep order. */
export function normalizeLayoutChatSide(
  root: TabGroupLayoutNode,
  chatGroupIds: Set<string>,
  side: ChatPanelSide
): TabGroupLayoutNode {
  if (root.type === 'leaf') {
    return root
  }
  const first = normalizeLayoutChatSide(root.first, chatGroupIds, side)
  const second = normalizeLayoutChatSide(root.second, chatGroupIds, side)
  if (root.direction !== 'horizontal') {
    return first === root.first && second === root.second ? root : { ...root, first, second }
  }
  const firstHasChat = layoutHoldsChat(first, chatGroupIds)
  const secondHasChat = layoutHoldsChat(second, chatGroupIds)
  if (firstHasChat === secondHasChat) {
    return first === root.first && second === root.second ? root : { ...root, first, second }
  }
  const chatFirst = firstHasChat && !secondHasChat
  const needsSwap = side === 'second' ? chatFirst : !chatFirst
  if (!needsSwap) {
    return first === root.first && second === root.second ? root : { ...root, first, second }
  }
  // Why: swapping columns mirrors the divider, so the content column keeps its width.
  return {
    ...root,
    first: second,
    second: first,
    ...(typeof root.ratio === 'number' ? { ratio: 1 - root.ratio } : {})
  }
}

function layoutHoldsChat(node: TabGroupLayoutNode, chatGroupIds: Set<string>): boolean {
  if (node.type === 'leaf') {
    return chatGroupIds.has(node.groupId)
  }
  return layoutHoldsChat(node.first, chatGroupIds) || layoutHoldsChat(node.second, chatGroupIds)
}
