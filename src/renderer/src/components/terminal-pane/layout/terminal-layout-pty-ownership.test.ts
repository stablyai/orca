import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { normalizeTerminalLayoutSnapshot } from './terminal-layout-normalization'
import { normalizeTerminalLayoutPtyOwnership } from '../../../../../shared/workspace-layout/terminal-topology/terminal-layout-pty-ownership'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'

function duplicatePtyLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      ratio: 0.4,
      first: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.25,
        first: { type: 'leaf', leafId: LEAF_1 },
        second: { type: 'leaf', leafId: LEAF_2 }
      },
      second: { type: 'leaf', leafId: LEAF_3 }
    },
    activeLeafId: LEAF_2,
    expandedLeafId: LEAF_1,
    ptyIdsByLeafId: {
      [LEAF_1]: 'pty-agent',
      [LEAF_2]: 'pty-agent',
      [LEAF_3]: 'remote:env-1@@term_setup'
    },
    buffersByLeafId: {
      [LEAF_1]: 'stale agent buffer',
      [LEAF_2]: 'active agent buffer',
      [LEAF_3]: 'setup buffer'
    },
    scrollbackRefsByLeafId: {
      [LEAF_1]: 'stale-agent-scrollback',
      [LEAF_2]: 'active-agent-scrollback',
      [LEAF_3]: 'setup-scrollback'
    },
    titlesByLeafId: {
      [LEAF_1]: 'stale agent',
      [LEAF_2]: 'active agent',
      [LEAF_3]: 'setup'
    }
  }
}

describe('terminal layout PTY ownership normalization', () => {
  it('keeps the active leaf and prunes the stale surface plus its metadata', () => {
    const normalized = normalizeTerminalLayoutSnapshot(duplicatePtyLayout())

    expect(normalized.changed).toBe(true)
    expect(normalized.snapshot).toEqual({
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.4,
        first: { type: 'leaf', leafId: LEAF_2 },
        second: { type: 'leaf', leafId: LEAF_3 }
      },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_2]: 'pty-agent',
        [LEAF_3]: 'remote:env-1@@term_setup'
      },
      buffersByLeafId: {
        [LEAF_2]: 'active agent buffer',
        [LEAF_3]: 'setup buffer'
      },
      scrollbackRefsByLeafId: {
        [LEAF_2]: 'active-agent-scrollback',
        [LEAF_3]: 'setup-scrollback'
      },
      titlesByLeafId: {
        [LEAF_2]: 'active agent',
        [LEAF_3]: 'setup'
      }
    })
  })

  it('carries missing scrollback metadata onto the surviving leaf', () => {
    const layout = duplicatePtyLayout()
    layout.buffersByLeafId = { [LEAF_1]: 'only cached buffer' }
    layout.scrollbackRefsByLeafId = { [LEAF_1]: 'only-scrollback-ref' }
    layout.titlesByLeafId = { [LEAF_1]: 'only cached title' }

    const normalized = normalizeTerminalLayoutSnapshot(layout).snapshot

    expect(normalized.buffersByLeafId).toEqual({ [LEAF_2]: 'only cached buffer' })
    expect(normalized.scrollbackRefsByLeafId).toEqual({ [LEAF_2]: 'only-scrollback-ref' })
    expect(normalized.titlesByLeafId).toEqual({ [LEAF_2]: 'only cached title' })
  })

  it('does not combine a retained buffer with a stale duplicate scrollback ref', () => {
    const layout = duplicatePtyLayout()
    layout.buffersByLeafId = { [LEAF_2]: 'active buffer' }
    layout.scrollbackRefsByLeafId = { [LEAF_1]: 'stale-scrollback-ref' }

    const normalized = normalizeTerminalLayoutPtyOwnership(layout).snapshot

    expect(normalized.buffersByLeafId).toEqual({ [LEAF_2]: 'active buffer' })
    expect(normalized.scrollbackRefsByLeafId).toBeUndefined()
  })

  it('coalesces chained duplicate metadata in layout order', () => {
    const layout = duplicatePtyLayout()
    layout.activeLeafId = LEAF_3
    layout.ptyIdsByLeafId = {
      [LEAF_1]: 'pty-agent',
      [LEAF_2]: 'pty-agent',
      [LEAF_3]: 'pty-agent'
    }
    layout.buffersByLeafId = {
      [LEAF_1]: 'first cached buffer',
      [LEAF_2]: 'second cached buffer'
    }
    layout.scrollbackRefsByLeafId = undefined

    const normalized = normalizeTerminalLayoutSnapshot(layout).snapshot

    expect(normalized.root).toEqual({ type: 'leaf', leafId: LEAF_3 })
    expect(normalized.buffersByLeafId).toEqual({ [LEAF_3]: 'first cached buffer' })
  })

  it('deduplicates rootless remount state without guessing among distinct PTYs', () => {
    const normalized = normalizeTerminalLayoutSnapshot({
      root: null,
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-agent',
        [LEAF_2]: 'pty-agent',
        [LEAF_3]: 'pty-setup'
      }
    })

    expect(normalized.snapshot).toEqual({
      root: null,
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_2]: 'pty-agent',
        [LEAF_3]: 'pty-setup'
      }
    })
  })

  it('keeps rooted ownership when stale focus names a dangling duplicate leaf', () => {
    const normalized = normalizeTerminalLayoutPtyOwnership({
      root: { type: 'leaf', leafId: LEAF_1 },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-agent',
        [LEAF_2]: 'pty-agent'
      }
    })

    expect(normalized.snapshot).toEqual({
      root: { type: 'leaf', leafId: LEAF_1 },
      activeLeafId: LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-agent' }
    })
  })

  it('preserves rootless pending focus while repairing duplicate ownership', () => {
    const normalized = normalizeTerminalLayoutSnapshot({
      root: null,
      activeLeafId: LEAF_3,
      expandedLeafId: LEAF_3,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-agent',
        [LEAF_2]: 'pty-agent'
      }
    })

    expect(normalized.snapshot).toEqual({
      root: null,
      activeLeafId: LEAF_3,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-agent' }
    })
  })

  it('keeps a valid active unbound leaf while repairing duplicate sibling ownership', () => {
    const normalized = normalizeTerminalLayoutPtyOwnership({
      root: {
        type: 'split',
        direction: 'vertical',
        first: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: LEAF_1 },
          second: { type: 'leaf', leafId: LEAF_2 }
        },
        second: { type: 'leaf', leafId: LEAF_3 }
      },
      activeLeafId: LEAF_3,
      expandedLeafId: LEAF_3,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-agent',
        [LEAF_2]: 'pty-agent'
      }
    })

    expect(normalized.snapshot).toEqual({
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_1 },
        second: { type: 'leaf', leafId: LEAF_3 }
      },
      activeLeafId: LEAF_3,
      expandedLeafId: LEAF_3,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-agent' }
    })
  })

  it('collapses repeated live leaf ids without looping during direct normalization', () => {
    const normalized = normalizeTerminalLayoutPtyOwnership({
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_1 },
        second: { type: 'leaf', leafId: LEAF_1 }
      },
      activeLeafId: LEAF_1,
      expandedLeafId: LEAF_1,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-agent' },
      buffersByLeafId: { [LEAF_1]: 'cached buffer' }
    })

    expect(normalized.snapshot).toEqual({
      root: { type: 'leaf', leafId: LEAF_1 },
      activeLeafId: LEAF_1,
      expandedLeafId: LEAF_1,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-agent' },
      buffersByLeafId: { [LEAF_1]: 'cached buffer' }
    })
    expect(normalizeTerminalLayoutPtyOwnership(normalized.snapshot)).toEqual({
      snapshot: normalized.snapshot,
      changed: false
    })
  })

  it('keeps active metadata when its retained leaf id also repeats', () => {
    const normalized = normalizeTerminalLayoutPtyOwnership({
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: LEAF_1 },
        second: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_2 },
          second: { type: 'leaf', leafId: LEAF_2 }
        }
      },
      activeLeafId: LEAF_2,
      expandedLeafId: LEAF_2,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-agent',
        [LEAF_2]: 'pty-agent'
      },
      buffersByLeafId: {
        [LEAF_1]: 'stale buffer',
        [LEAF_2]: 'active buffer'
      },
      titlesByLeafId: {
        [LEAF_1]: 'stale title',
        [LEAF_2]: 'active title'
      }
    }).snapshot

    expect(normalized).toEqual({
      root: { type: 'leaf', leafId: LEAF_2 },
      activeLeafId: LEAF_2,
      expandedLeafId: LEAF_2,
      ptyIdsByLeafId: { [LEAF_2]: 'pty-agent' },
      buffersByLeafId: { [LEAF_2]: 'active buffer' },
      titlesByLeafId: { [LEAF_2]: 'active title' }
    })
  })

  it('retains one repeated PTY leaf alongside distinct sibling ownership', () => {
    const normalized = normalizeTerminalLayoutSnapshot({
      root: {
        type: 'split',
        direction: 'vertical',
        first: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: LEAF_1 },
          second: { type: 'leaf', leafId: LEAF_1 }
        },
        second: { type: 'leaf', leafId: LEAF_2 }
      },
      activeLeafId: LEAF_1,
      expandedLeafId: LEAF_1,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-agent',
        [LEAF_2]: 'pty-shell'
      }
    }).snapshot

    expect(normalized).toEqual({
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_1 },
        second: { type: 'leaf', leafId: LEAF_2 }
      },
      activeLeafId: LEAF_1,
      expandedLeafId: LEAF_1,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-agent',
        [LEAF_2]: 'pty-shell'
      }
    })
  })
})
