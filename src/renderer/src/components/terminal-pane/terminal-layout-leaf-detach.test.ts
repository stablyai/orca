import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import { detachTerminalLayoutLeaf } from './terminal-layout-leaf-detach'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'

function splitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      ratio: 0.25,
      first: { type: 'leaf', leafId: LEAF_1 },
      second: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.7,
        first: { type: 'leaf', leafId: LEAF_2 },
        second: { type: 'leaf', leafId: LEAF_3 }
      }
    },
    activeLeafId: LEAF_2,
    expandedLeafId: LEAF_3,
    ptyIdsByLeafId: {
      [LEAF_1]: 'pty-1',
      [LEAF_2]: 'remote:env-1@@terminal-1',
      [LEAF_3]: 'pty-3'
    },
    buffersByLeafId: {
      [LEAF_1]: 'buffer-1',
      [LEAF_2]: 'buffer-2',
      [LEAF_3]: 'buffer-3'
    },
    scrollbackRefsByLeafId: {
      [LEAF_1]: 'scrollback-1',
      [LEAF_2]: 'scrollback-2',
      [LEAF_3]: 'scrollback-3'
    },
    titlesByLeafId: {
      [LEAF_1]: 'one',
      [LEAF_2]: 'remote shell',
      [LEAF_3]: 'three'
    }
  }
}

describe('detachTerminalLayoutLeaf', () => {
  it('extracts a nested leaf into a single-pane layout while preserving SSH PTY state', () => {
    const detached = detachTerminalLayoutLeaf(splitLayout(), LEAF_2)

    expect(detached?.ptyId).toBe('remote:env-1@@terminal-1')
    expect(detached?.detachedLayout).toEqual({
      root: { type: 'leaf', leafId: LEAF_2 },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_2]: 'remote:env-1@@terminal-1' },
      buffersByLeafId: { [LEAF_2]: 'buffer-2' },
      scrollbackRefsByLeafId: { [LEAF_2]: 'scrollback-2' },
      titlesByLeafId: { [LEAF_2]: 'remote shell' }
    })
    expect(detached?.sourceLayout).toEqual({
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.25,
        first: { type: 'leaf', leafId: LEAF_1 },
        second: { type: 'leaf', leafId: LEAF_3 }
      },
      activeLeafId: LEAF_1,
      expandedLeafId: LEAF_3,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-1',
        [LEAF_3]: 'pty-3'
      },
      buffersByLeafId: {
        [LEAF_1]: 'buffer-1',
        [LEAF_3]: 'buffer-3'
      },
      scrollbackRefsByLeafId: {
        [LEAF_1]: 'scrollback-1',
        [LEAF_3]: 'scrollback-3'
      },
      titlesByLeafId: {
        [LEAF_1]: 'one',
        [LEAF_3]: 'three'
      }
    })
  })

  it('clears source expanded selection when the expanded leaf is detached', () => {
    const detached = detachTerminalLayoutLeaf(splitLayout(), LEAF_3)

    expect(detached?.sourceLayout.expandedLeafId).toBeNull()
    expect(detached?.sourceLayout.root).toEqual({
      type: 'split',
      direction: 'vertical',
      ratio: 0.25,
      first: { type: 'leaf', leafId: LEAF_1 },
      second: { type: 'leaf', leafId: LEAF_2 }
    })
  })

  it('returns null for missing or only leaf layouts', () => {
    expect(detachTerminalLayoutLeaf(splitLayout(), 'missing')).toBeNull()
    expect(
      detachTerminalLayoutLeaf(
        {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_1]: 'pty-1' }
        },
        LEAF_1
      )
    ).toBeNull()
  })
})
