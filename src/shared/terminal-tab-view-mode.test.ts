import { describe, expect, it } from 'vitest'
import {
  normalizeTerminalChatPair,
  resolveTerminalChatPairWrite,
  resolveTerminalTabViewMode
} from './terminal-tab-view-mode'
import type { TerminalPaneLayoutNode } from './terminal-tab-types'

const SPLIT: TerminalPaneLayoutNode = {
  type: 'split',
  direction: 'vertical',
  first: { type: 'leaf', leafId: 'a' },
  second: { type: 'leaf', leafId: 'b' }
}

describe('resolveTerminalTabViewMode', () => {
  it('reads the unified tab first and the row as the fallback', () => {
    expect(resolveTerminalTabViewMode({ viewMode: 'terminal' }, { viewMode: 'chat' })).toBe(
      'terminal'
    )
    expect(resolveTerminalTabViewMode({}, { viewMode: 'chat' })).toBe('chat')
    expect(resolveTerminalTabViewMode(null, {})).toBeUndefined()
  })
})

describe('resolveTerminalChatPairWrite', () => {
  const write = (
    current: { viewMode?: 'terminal' | 'chat'; chatLeafId?: string },
    viewMode: 'terminal' | 'chat',
    leafId: string | null
  ) => resolveTerminalChatPairWrite({ current, root: SPLIT, viewMode, leafId })

  it('claims or moves chat to an addressed leaf', () => {
    expect(write({}, 'chat', 'b')).toEqual({ viewMode: 'chat', chatLeafId: 'b' })
    expect(write({ viewMode: 'chat', chatLeafId: 'a' }, 'chat', 'b')).toEqual({
      viewMode: 'chat',
      chatLeafId: 'b'
    })
  })

  it('keeps only a valid owner for a parent-addressed chat', () => {
    expect(write({ chatLeafId: 'a' }, 'chat', null)).toEqual({ viewMode: 'chat', chatLeafId: 'a' })
    // A terminal tab's leftover owner is stale: the route claims the focused pane instead.
    expect(write({ viewMode: 'terminal', chatLeafId: 'a' }, 'chat', null)).toEqual({
      viewMode: 'chat'
    })
    expect(write({ viewMode: 'chat', chatLeafId: 'gone' }, 'chat', null)).toEqual({
      viewMode: 'chat'
    })
  })

  it('clears the owner on terminal and changes nothing for an unknown leaf', () => {
    expect(write({ viewMode: 'chat', chatLeafId: 'a' }, 'terminal', 'a')).toEqual({
      viewMode: 'terminal'
    })
    expect(write({ viewMode: 'chat', chatLeafId: 'a' }, 'terminal', 'gone')).toBeNull()
  })
})

describe('normalizeTerminalChatPair', () => {
  it('reads a present owner outside the tree as terminal, and an unknown tree as unproven', () => {
    expect(normalizeTerminalChatPair({ viewMode: 'chat', chatLeafId: 'gone' }, SPLIT)).toEqual({
      viewMode: 'terminal'
    })
    expect(normalizeTerminalChatPair({ viewMode: 'chat', chatLeafId: 'a' }, SPLIT)).toEqual({
      viewMode: 'chat',
      chatLeafId: 'a'
    })
    expect(normalizeTerminalChatPair({ viewMode: 'chat', chatLeafId: 'gone' }, null)).toEqual({
      viewMode: 'chat',
      chatLeafId: 'gone'
    })
  })
})
