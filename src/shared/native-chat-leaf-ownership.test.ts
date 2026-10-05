import { describe, expect, it } from 'vitest'
import {
  resolveNativeChatActiveLayoutLeafId,
  terminalLayoutNodeContainsLeaf
} from './native-chat-leaf-ownership'
import type { TerminalPaneLayoutNode } from './terminal-tab-types'

const split: TerminalPaneLayoutNode = {
  type: 'split',
  direction: 'vertical',
  first: { type: 'leaf', leafId: 'a' },
  second: { type: 'leaf', leafId: 'b' }
}

describe('native chat leaf ownership in shared code', () => {
  it('finds leaves anywhere in the tree and nothing in an unknown one', () => {
    expect(terminalLayoutNodeContainsLeaf(split, 'b')).toBe(true)
    expect(terminalLayoutNodeContainsLeaf(split, 'gone')).toBe(false)
    expect(terminalLayoutNodeContainsLeaf(null, 'a')).toBe(false)
  })

  it('never names an active leaf that left the tree', () => {
    expect(
      resolveNativeChatActiveLayoutLeafId({
        root: split,
        activeLeafId: 'gone',
        expandedLeafId: null
      })
    ).toBeNull()
    expect(
      resolveNativeChatActiveLayoutLeafId({ root: split, activeLeafId: 'b', expandedLeafId: null })
    ).toBe('b')
  })
})
