import { describe, expect, it } from 'vitest'
import { planTerminalLiveLayoutInsertions } from './terminal-live-layout-reconciliation'
import type { TerminalPaneLayoutNode } from '../../../../shared/types'

describe('planTerminalLiveLayoutInsertions', () => {
  it('plans a host-added split leaf from an already-mounted source leaf', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    }

    expect(planTerminalLiveLayoutInsertions(layout, ['leaf-a'])).toEqual([
      { sourceLeafId: 'leaf-a', newLeafId: 'leaf-b', direction: 'vertical' }
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
      { sourceLeafId: 'leaf-a', newLeafId: 'leaf-b', direction: 'vertical' },
      { sourceLeafId: 'leaf-b', newLeafId: 'leaf-c', direction: 'horizontal' }
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
