import { describe, expect, it } from 'vitest'
import { subtreeHasChatGroup } from './subtree-chat-groups'
import type { TabGroupLayoutNode } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { buildSplitNode } from '../../../../shared/workspace-layout/tab-groups/tab-group-layout-tree'

describe('subtreeHasChatGroup', () => {
  it('matches a chat leaf by group id', () => {
    const layout = buildSplitNode('editor', 'chat', 'horizontal', 'second')
    expect(subtreeHasChatGroup(layout, new Set(['chat']))).toBe(true)
  })

  it('rejects subtrees without a chat group', () => {
    const layout = buildSplitNode('editor', 'terminal', 'horizontal', 'second')
    expect(subtreeHasChatGroup(layout, new Set(['elsewhere']))).toBe(false)
    const leaf: TabGroupLayoutNode = { type: 'leaf', groupId: 'terminal' }
    expect(subtreeHasChatGroup(leaf, new Set(['elsewhere']))).toBe(false)
  })

  it('finds a chat group nested one level deeper', () => {
    const inner: TabGroupLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', groupId: 'editor' },
      second: { type: 'leaf', groupId: 'chat' },
      ratio: 0.5
    }
    const layout: TabGroupLayoutNode = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'terminal' },
      second: inner,
      ratio: 0.5
    }
    expect(subtreeHasChatGroup(layout, new Set(['chat']))).toBe(true)
  })
})
