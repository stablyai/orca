import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { ManagedPane } from './pane-manager-types'
import { resolveLeafIdForManager } from './pane-key-resolution'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

function makeManager(args: {
  numericPaneId: number | null
  panes: Pick<ManagedPane, 'id' | 'leafId'>[]
}) {
  return {
    getNumericIdForLeaf: () => args.numericPaneId,
    getPanes: () => args.panes as ManagedPane[]
  }
}

describe('pane-key resolution', () => {
  it('reports ownership-mismatch when the numeric pane handle now belongs to another leaf', () => {
    const manager = makeManager({
      numericPaneId: 7,
      panes: [{ id: 7, leafId: OTHER_LEAF_ID as never }]
    })

    expect(resolveLeafIdForManager('tab-1', LEAF_ID, manager, PANE_KEY)).toEqual({
      status: 'unresolved',
      paneKey: PANE_KEY,
      leafId: LEAF_ID,
      reason: 'ownership-mismatch'
    })
  })
})
