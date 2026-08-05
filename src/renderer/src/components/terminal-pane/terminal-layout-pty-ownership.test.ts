import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import { normalizeTerminalLayoutSnapshot } from './terminal-layout-leaf-ids'
import { normalizeTerminalLayoutPtyOwnership } from './terminal-layout-pty-ownership'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'

function collectRootLeafIds(layout: TerminalLayoutSnapshot): string[] {
  const visit = (node: NonNullable<TerminalLayoutSnapshot['root']>): string[] =>
    node.type === 'leaf' ? [node.leafId] : [...visit(node.first), ...visit(node.second)]
  return layout.root ? visit(layout.root) : []
}

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

  it('keeps the first layout leaf when focus belongs to another PTY', () => {
    const layout = duplicatePtyLayout()
    layout.activeLeafId = LEAF_3
    layout.expandedLeafId = null

    const normalized = normalizeTerminalLayoutSnapshot(layout)

    expect(normalized.snapshot.root).toEqual({
      type: 'split',
      direction: 'vertical',
      ratio: 0.4,
      first: { type: 'leaf', leafId: LEAF_1 },
      second: { type: 'leaf', leafId: LEAF_3 }
    })
    expect(normalized.snapshot.activeLeafId).toBe(LEAF_3)
    expect(normalized.snapshot.ptyIdsByLeafId).toEqual({
      [LEAF_1]: 'pty-agent',
      [LEAF_3]: 'remote:env-1@@term_setup'
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

  it('repairs rootless duplicate ownership in one idempotent pass', () => {
    const normalized = normalizeTerminalLayoutSnapshot({
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-agent',
        [LEAF_2]: 'pty-agent'
      }
    })

    expect(normalized.snapshot).toEqual({
      root: null,
      activeLeafId: LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-agent' }
    })
    expect(normalizeTerminalLayoutSnapshot(normalized.snapshot)).toEqual({
      snapshot: normalized.snapshot,
      changed: false
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

  it('repairs dangling rooted selection during direct ownership normalization', () => {
    const normalized = normalizeTerminalLayoutPtyOwnership({
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_1 },
        second: { type: 'leaf', leafId: LEAF_2 }
      },
      activeLeafId: LEAF_3,
      expandedLeafId: LEAF_3,
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

  it('preserves PTY ownership while collapsing repeated live leaf ids', () => {
    const normalized = normalizeTerminalLayoutSnapshot({
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
    expect(normalizeTerminalLayoutSnapshot(normalized.snapshot)).toEqual({
      snapshot: normalized.snapshot,
      changed: false
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

  it('preserves valid split layouts by identity', () => {
    const layout = duplicatePtyLayout()
    layout.ptyIdsByLeafId = {
      [LEAF_1]: 'pty-1',
      [LEAF_2]: 'pty-2',
      [LEAF_3]: 'remote:env-1@@term_setup'
    }

    const normalized = normalizeTerminalLayoutSnapshot(layout)

    expect(normalized).toEqual({ snapshot: layout, changed: false })
    expect(normalized.snapshot).toBe(layout)
  })

  it('is idempotent and preserves one owner across PTY and focus permutations', () => {
    const ptyOptions = [undefined, 'pty-a', 'remote:env-1@@term_b'] as const
    for (const firstPtyId of ptyOptions) {
      for (const secondPtyId of ptyOptions) {
        for (const thirdPtyId of ptyOptions) {
          for (const activeLeafId of [LEAF_1, LEAF_2, LEAF_3]) {
            const ptyIdsByLeafId = Object.fromEntries(
              [
                [LEAF_1, firstPtyId],
                [LEAF_2, secondPtyId],
                [LEAF_3, thirdPtyId]
              ].filter((entry): entry is [string, string] => entry[1] !== undefined)
            )
            const layout = duplicatePtyLayout()
            layout.activeLeafId = activeLeafId
            layout.expandedLeafId = activeLeafId
            layout.ptyIdsByLeafId = ptyIdsByLeafId
            const before = structuredClone(layout)

            const normalized = normalizeTerminalLayoutSnapshot(layout).snapshot
            const normalizedPtyIds = Object.values(normalized.ptyIdsByLeafId ?? {})
            const rootLeafIds = new Set(collectRootLeafIds(normalized))

            expect(new Set(normalizedPtyIds).size).toBe(normalizedPtyIds.length)
            expect(
              Object.keys(normalized.ptyIdsByLeafId ?? {}).every((id) => rootLeafIds.has(id))
            ).toBe(true)
            expect(normalized.activeLeafId && rootLeafIds.has(normalized.activeLeafId)).toBe(true)
            expect(normalizeTerminalLayoutSnapshot(normalized)).toEqual({
              snapshot: normalized,
              changed: false
            })
            expect(layout).toEqual(before)
          }
        }
      }
    }
  })
})
