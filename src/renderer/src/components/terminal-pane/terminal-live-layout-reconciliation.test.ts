import { describe, expect, it } from 'vitest'
import {
  isHostAuthoritativeLayout,
  planTerminalLiveLayoutInsertions,
  planTerminalLiveLayoutRemovals,
  selectRetiredPaneIds,
  trackRetiredLeafIds
} from './terminal-live-layout-reconciliation'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'

const LOCAL_PTY = 'pty-local-123'
const REMOTE_PTY = 'remote:env-1@@term_abc'

describe('isHostAuthoritativeLayout', () => {
  it('is true for any web client regardless of pty ids', () => {
    expect(isHostAuthoritativeLayout({ isWebClient: true, ptyIdsByLeafId: { a: LOCAL_PTY } })).toBe(
      true
    )
  })

  it('is true for a desktop client when a leaf has a remote-runtime pty (remote server tab)', () => {
    // Remote-server desktop panes need reconciliation to materialize host-published splits.
    expect(
      isHostAuthoritativeLayout({
        isWebClient: false,
        ptyIdsByLeafId: { a: LOCAL_PTY, b: REMOTE_PTY }
      })
    ).toBe(true)
  })

  it('is false for a desktop client with only local ptys (local tab splits directly)', () => {
    expect(
      isHostAuthoritativeLayout({ isWebClient: false, ptyIdsByLeafId: { a: LOCAL_PTY } })
    ).toBe(false)
  })

  it('is false for a desktop client with no pty ids', () => {
    expect(isHostAuthoritativeLayout({ isWebClient: false, ptyIdsByLeafId: undefined })).toBe(false)
  })
})

describe('planTerminalLiveLayoutInsertions', () => {
  it('plans a host-added split leaf from an already-mounted source leaf', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    }

    expect(planTerminalLiveLayoutInsertions(layout, ['leaf-a'])).toEqual([
      {
        sourceLeafId: 'leaf-a',
        sourceLeafIds: ['leaf-a'],
        newLeafId: 'leaf-b',
        direction: 'vertical',
        placement: 'after'
      }
    ])
  })

  it('plans nested missing leaves in the order splitPane can apply them', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-b' },
        second: { type: 'leaf', leafId: 'leaf-c' }
      }
    }

    expect(planTerminalLiveLayoutInsertions(layout, ['leaf-a'])).toEqual([
      {
        sourceLeafId: 'leaf-a',
        sourceLeafIds: ['leaf-a'],
        newLeafId: 'leaf-b',
        direction: 'vertical',
        placement: 'after'
      },
      {
        sourceLeafId: 'leaf-b',
        sourceLeafIds: ['leaf-b'],
        newLeafId: 'leaf-c',
        direction: 'horizontal',
        placement: 'after'
      }
    ])
  })

  it('bridges a missing parent second subtree before filling the first subtree', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-a' },
        second: { type: 'leaf', leafId: 'leaf-b' }
      },
      second: { type: 'leaf', leafId: 'leaf-c' }
    }

    expect(planTerminalLiveLayoutInsertions(layout, ['leaf-a'])).toEqual([
      {
        sourceLeafId: 'leaf-a',
        sourceLeafIds: ['leaf-a'],
        newLeafId: 'leaf-c',
        direction: 'vertical',
        placement: 'after'
      },
      {
        sourceLeafId: 'leaf-a',
        sourceLeafIds: ['leaf-a'],
        newLeafId: 'leaf-b',
        direction: 'horizontal',
        placement: 'after'
      }
    ])
  })

  it('plans a parent sibling after an already-mounted first-side split with host ratio', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.35,
      first: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-a' },
        second: { type: 'leaf', leafId: 'leaf-b' }
      },
      second: { type: 'leaf', leafId: 'leaf-c' }
    }

    expect(planTerminalLiveLayoutInsertions(layout, ['leaf-a', 'leaf-b'])).toEqual([
      {
        sourceLeafId: 'leaf-b',
        sourceLeafIds: ['leaf-a', 'leaf-b'],
        newLeafId: 'leaf-c',
        direction: 'vertical',
        placement: 'after',
        ratio: 0.35
      }
    ])
  })

  it('plans a missing first subtree before an already-mounted second leaf', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    }

    expect(planTerminalLiveLayoutInsertions(layout, ['leaf-b'])).toEqual([
      {
        sourceLeafId: 'leaf-b',
        sourceLeafIds: ['leaf-b'],
        newLeafId: 'leaf-a',
        direction: 'vertical',
        placement: 'before'
      }
    ])
  })

  it('plans nested missing first subtrees from an anchor in the second subtree', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-b' },
        second: { type: 'leaf', leafId: 'leaf-c' }
      }
    }

    expect(planTerminalLiveLayoutInsertions(layout, ['leaf-c'])).toEqual([
      {
        sourceLeafId: 'leaf-c',
        sourceLeafIds: ['leaf-c'],
        newLeafId: 'leaf-a',
        direction: 'vertical',
        placement: 'before'
      },
      {
        sourceLeafId: 'leaf-c',
        sourceLeafIds: ['leaf-c'],
        newLeafId: 'leaf-b',
        direction: 'horizontal',
        placement: 'before'
      }
    ])
  })

  it('plans a parent sibling before an already-mounted second-side split with host ratio', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.25,
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-b' },
        second: { type: 'leaf', leafId: 'leaf-c' }
      }
    }

    expect(planTerminalLiveLayoutInsertions(layout, ['leaf-b', 'leaf-c'])).toEqual([
      {
        sourceLeafId: 'leaf-b',
        sourceLeafIds: ['leaf-b', 'leaf-c'],
        newLeafId: 'leaf-a',
        direction: 'vertical',
        placement: 'before',
        ratio: 0.25
      }
    ])
  })

  it('does not plan insertions when the layout has no mounted anchor leaf', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    }

    expect(planTerminalLiveLayoutInsertions(layout, [])).toEqual([])
  })
})

describe('planTerminalLiveLayoutRemovals', () => {
  // Every mounted leaf counted as retired: the layout alone must veto removals.
  const BOTH = new Set(['leaf-a', 'leaf-b'])

  it('plans the mounted leaf a host-retired layout no longer names', () => {
    // Closing a host split retires its leaf; remove the mounted pane too or it remains a blank ghost.
    const layout: TerminalPaneLayoutNode = { type: 'leaf', leafId: 'leaf-a' }

    expect(
      planTerminalLiveLayoutRemovals(layout, ['leaf-a', 'leaf-b'], new Set(['leaf-b']))
    ).toEqual(['leaf-b'])
  })

  it('plans nothing when every mounted leaf is still in the layout', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    }

    expect(planTerminalLiveLayoutRemovals(layout, ['leaf-a', 'leaf-b'], BOTH)).toEqual([])
    expect(planTerminalLiveLayoutRemovals(layout, ['leaf-a'], BOTH)).toEqual([])
  })

  it('plans nothing for an empty layout', () => {
    expect(planTerminalLiveLayoutRemovals(null, ['leaf-a'], BOTH)).toEqual([])
    expect(planTerminalLiveLayoutRemovals(undefined, ['leaf-a'], BOTH)).toEqual([])
  })

  it('leaves a mounted leaf the host has never named alone', () => {
    // Snapshots can race a still-spawning client pane; only previously published leaves can be retired.
    const layout: TerminalPaneLayoutNode = { type: 'leaf', leafId: 'leaf-a' }

    expect(
      planTerminalLiveLayoutRemovals(layout, ['leaf-a', 'leaf-new'], new Set(['leaf-a']))
    ).toEqual([])
    expect(planTerminalLiveLayoutRemovals(layout, ['leaf-a', 'leaf-new'], new Set())).toEqual([])
  })
})

describe('selectRetiredPaneIds', () => {
  const view = (ptyIdsByPane: Record<number, string | null | undefined>) => ({
    paneCount: Object.keys(ptyIdsByPane).length,
    paneIdForLeaf: (leafId: string) => (leafId === 'leaf-b' ? 2 : leafId === 'leaf-c' ? 3 : null),
    ptyIdForPane: (paneId: number) => ptyIdsByPane[paneId]
  })

  it('closes the pane whose transport lost its PTY', () => {
    // A retired leaf without a PTY is the blank ghost the host removed.
    expect(selectRetiredPaneIds(['leaf-b'], view({ 1: 'pty-a', 2: null }))).toEqual([2])
  })

  it('keeps a pane still bound to a PTY or not yet attached to a transport', () => {
    // Live PTYs and missing transports may reflect stale snapshots or mounting, never proven retirement.
    expect(selectRetiredPaneIds(['leaf-b'], view({ 1: 'pty-a', 2: 'pty-b' }))).toEqual([])
    expect(selectRetiredPaneIds(['leaf-b'], view({ 1: 'pty-a', 2: undefined }))).toEqual([])
  })

  it('never removes the last pane on the tab', () => {
    expect(selectRetiredPaneIds(['leaf-b'], view({ 2: null }))).toEqual([])
    expect(selectRetiredPaneIds(['leaf-b', 'leaf-c'], view({ 2: null, 3: null }))).toEqual([2])
  })

  it('skips a leaf that has no mounted pane', () => {
    expect(selectRetiredPaneIds(['leaf-x'], view({ 1: 'pty-a', 2: null }))).toEqual([])
  })
})

describe('trackRetiredLeafIds', () => {
  it('retires a mounted leaf the host dropped from its layout', () => {
    expect(
      trackRetiredLeafIds({
        retiredLeafIds: new Set(),
        previousLayoutLeafIds: new Set(['leaf-a', 'leaf-b']),
        layoutLeafIds: new Set(['leaf-a']),
        mountedLeafIds: ['leaf-a', 'leaf-b']
      })
    ).toEqual(new Set(['leaf-b']))
  })

  it('keeps a retired leaf until its pane is gone', () => {
    // Keep retirement pending if a bound PTY delayed removal; retry after it clears.
    const args = {
      retiredLeafIds: new Set(['leaf-b']),
      previousLayoutLeafIds: new Set(['leaf-a']),
      layoutLeafIds: new Set(['leaf-a'])
    }
    expect(trackRetiredLeafIds({ ...args, mountedLeafIds: ['leaf-a', 'leaf-b'] })).toEqual(
      new Set(['leaf-b'])
    )
    expect(trackRetiredLeafIds({ ...args, mountedLeafIds: ['leaf-a'] })).toEqual(new Set())
  })

  it('forgets a retired leaf the host names again', () => {
    expect(
      trackRetiredLeafIds({
        retiredLeafIds: new Set(['leaf-b']),
        previousLayoutLeafIds: new Set(['leaf-a']),
        layoutLeafIds: new Set(['leaf-a', 'leaf-b']),
        mountedLeafIds: ['leaf-a', 'leaf-b']
      })
    ).toEqual(new Set())
  })

  it('never retires a leaf the host has not named', () => {
    expect(
      trackRetiredLeafIds({
        retiredLeafIds: new Set(),
        previousLayoutLeafIds: new Set(['leaf-a']),
        layoutLeafIds: new Set(['leaf-a']),
        mountedLeafIds: ['leaf-a', 'leaf-new']
      })
    ).toEqual(new Set())
  })
})

describe('host retirement that lands before the transport teardown', () => {
  it('removes the pane on the reconciliation after its PTY clears', () => {
    // Host layout and PTY exit arrive separately; preserve the bound pane until exit clears it, then reconcile again.
    const layout: TerminalPaneLayoutNode = { type: 'leaf', leafId: 'leaf-a' }
    const mounted = ['leaf-a', 'leaf-b']
    const paneIdForLeaf = (leafId: string) =>
      leafId === 'leaf-a' ? 1 : leafId === 'leaf-b' ? 2 : null

    let retired = trackRetiredLeafIds({
      retiredLeafIds: new Set(),
      previousLayoutLeafIds: new Set(mounted),
      layoutLeafIds: new Set(['leaf-a']),
      mountedLeafIds: mounted
    })
    let removals = planTerminalLiveLayoutRemovals(layout, mounted, retired)
    expect(removals).toEqual(['leaf-b'])
    expect(
      selectRetiredPaneIds(removals, {
        paneCount: 2,
        paneIdForLeaf,
        ptyIdForPane: (paneId) => (paneId === 2 ? 'pty-b' : 'pty-a')
      })
    ).toEqual([])

    retired = trackRetiredLeafIds({
      retiredLeafIds: retired,
      previousLayoutLeafIds: new Set(['leaf-a']),
      layoutLeafIds: new Set(['leaf-a']),
      mountedLeafIds: mounted
    })
    removals = planTerminalLiveLayoutRemovals(layout, mounted, retired)
    expect(
      selectRetiredPaneIds(removals, {
        paneCount: 2,
        paneIdForLeaf,
        ptyIdForPane: (paneId) => (paneId === 2 ? null : 'pty-a')
      })
    ).toEqual([2])
  })
})
