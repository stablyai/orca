import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from './types'
import { retireTerminalLayoutLeaf } from './terminal-layout-leaf-retirement'

function splitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'leaf-b' },
        second: { type: 'leaf', leafId: 'leaf-c' }
      }
    },
    activeLeafId: 'leaf-b',
    expandedLeafId: 'leaf-b',
    ptyIdsByLeafId: { 'leaf-a': 'pty-a', 'leaf-b': 'pty-b', 'leaf-c': 'pty-c' },
    buffersByLeafId: { 'leaf-a': 'a', 'leaf-b': 'b', 'leaf-c': 'c' },
    scrollbackRefsByLeafId: { 'leaf-a': 'ra', 'leaf-b': 'rb', 'leaf-c': 'rc' },
    titlesByLeafId: { 'leaf-a': 'A', 'leaf-b': 'B', 'leaf-c': 'C' }
  }
}

describe('retireTerminalLayoutLeaf', () => {
  it('collapses only the exact nested leaf and its metadata', () => {
    const result = retireTerminalLayoutLeaf(splitLayout(), {
      leafId: 'leaf-b',
      expectedPtyId: 'pty-b'
    })

    expect(result?.layout).toEqual({
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-a' },
        second: { type: 'leaf', leafId: 'leaf-c' }
      },
      activeLeafId: 'leaf-a',
      expandedLeafId: null,
      ptyIdsByLeafId: { 'leaf-a': 'pty-a', 'leaf-c': 'pty-c' },
      buffersByLeafId: { 'leaf-a': 'a', 'leaf-c': 'c' },
      scrollbackRefsByLeafId: { 'leaf-a': 'ra', 'leaf-c': 'rc' },
      titlesByLeafId: { 'leaf-a': 'A', 'leaf-c': 'C' }
    })
  })

  it('refuses a stale PTY binding for the same leaf', () => {
    expect(
      retireTerminalLayoutLeaf(splitLayout(), {
        leafId: 'leaf-b',
        expectedPtyId: 'pty-old'
      })
    ).toBeNull()
  })

  it('returns a removed parent for the final exact leaf', () => {
    expect(
      retireTerminalLayoutLeaf(
        {
          root: { type: 'leaf', leafId: 'leaf-a' },
          activeLeafId: 'leaf-a',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-a': 'pty-a' }
        },
        { leafId: 'leaf-a', expectedPtyId: 'pty-a' }
      )
    ).toEqual({ layout: null, removedPtyId: 'pty-a' })
  })
})
