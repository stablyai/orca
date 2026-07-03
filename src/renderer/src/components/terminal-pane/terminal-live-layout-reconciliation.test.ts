import { describe, expect, it } from 'vitest'
import {
  isHostAuthoritativeLayout,
  planTerminalLiveLayoutInsertions
} from './terminal-live-layout-reconciliation'
import type { TerminalPaneLayoutNode } from '../../../../shared/types'

const LOCAL_PTY = 'pty-local-123'
const REMOTE_PTY = 'remote:env-1@@term_abc'

describe('isHostAuthoritativeLayout', () => {
  it('is true for any web client regardless of pty ids', () => {
    expect(isHostAuthoritativeLayout({ isWebClient: true, ptyIdsByLeafId: { a: LOCAL_PTY } })).toBe(
      true
    )
  })

  it('is true for a desktop client when a leaf has a remote-runtime pty (remote server tab)', () => {
    // Why: the split-render bug — desktop viewing a remote server got the host
    // layout but skipped reconciliation, so the split never rendered.
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
