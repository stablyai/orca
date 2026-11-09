import { describe, expect, it } from 'vitest'
import type { TerminalPaneLayoutNode } from '../../../../../shared/workspace-layout/terminal-tab-types'
import {
  collectLeafIdsInOrder,
  collectLeafIdsInReplayCreationOrder
} from './terminal-layout-leaf-traversal'

describe('collectLeafIdsInReplayCreationOrder', () => {
  it('visits the outer right leaf before the inner left split continuation', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'A' },
        second: { type: 'leaf', leafId: 'B' }
      },
      second: { type: 'leaf', leafId: 'C' }
    }

    expect(collectLeafIdsInOrder(layout)).toEqual(['A', 'B', 'C'])
    expect(collectLeafIdsInReplayCreationOrder(layout)).toEqual(['A', 'C', 'B'])
  })
})
