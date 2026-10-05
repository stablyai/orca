import { describe, expect, it } from 'vitest'
import {
  normalizeTerminalChatPair,
  pinTerminalChatOwnerOnGrowth,
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

describe('resolveTerminalChatPairWrite with a host owner pick (F1)', () => {
  const write = (
    current: { viewMode?: 'terminal' | 'chat'; chatLeafId?: string },
    picked: string | null
  ) =>
    resolveTerminalChatPairWrite({
      current,
      root: SPLIT,
      viewMode: 'chat',
      leafId: null,
      pickOwner: () => picked
    })

  it('stores the picked owner for a parent-addressed chat that has no valid owner', () => {
    expect(write({}, 'b')).toEqual({ viewMode: 'chat', chatLeafId: 'b' })
    expect(write({ viewMode: 'chat' }, 'a')).toEqual({ viewMode: 'chat', chatLeafId: 'a' })
    expect(write({ viewMode: 'terminal', chatLeafId: 'a' }, 'b')).toEqual({
      viewMode: 'chat',
      chatLeafId: 'b'
    })
  })

  it('changes nothing when the host finds no pane that may own chat', () => {
    expect(write({}, null)).toBeNull()
    expect(write({}, 'gone')).toBeNull()
  })

  it('never consults the pick while a valid owner exists or for an addressed write', () => {
    expect(write({ viewMode: 'chat', chatLeafId: 'a' }, 'b')).toEqual({
      viewMode: 'chat',
      chatLeafId: 'a'
    })
    expect(
      resolveTerminalChatPairWrite({
        current: {},
        root: SPLIT,
        viewMode: 'chat',
        leafId: 'a',
        pickOwner: () => 'b'
      })
    ).toEqual({ viewMode: 'chat', chatLeafId: 'a' })
  })
})

describe('pinTerminalChatOwnerOnGrowth (F1)', () => {
  const SOLE_A: TerminalPaneLayoutNode = { type: 'leaf', leafId: 'a' }
  const pin = (args: Partial<Parameters<typeof pinTerminalChatOwnerOnGrowth>[0]>) =>
    pinTerminalChatOwnerOnGrowth({
      viewMode: 'chat',
      chatLeafId: undefined,
      priorRoot: SOLE_A,
      nextRoot: SPLIT,
      ...args
    })

  it('pins an ownerless chat to its only pre-growth pane', () => {
    expect(pin({})).toBe('a')
  })

  it('keeps any stored owner, valid or not, and never pins a non-chat tab', () => {
    expect(pin({ chatLeafId: 'b' })).toBe('b')
    expect(pin({ chatLeafId: 'gone' })).toBe('gone')
    expect(pin({ viewMode: 'terminal' })).toBeUndefined()
    expect(pin({ viewMode: undefined })).toBeUndefined()
  })

  it('pins nothing when the tree did not grow from one pane that it still holds', () => {
    expect(pin({ priorRoot: SPLIT })).toBeUndefined()
    expect(pin({ priorRoot: null })).toBeUndefined()
    expect(pin({ nextRoot: SOLE_A })).toBeUndefined()
    expect(pin({ priorRoot: { type: 'leaf', leafId: 'c' } })).toBeUndefined()
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
