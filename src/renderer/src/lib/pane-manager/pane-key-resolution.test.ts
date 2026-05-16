import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { ManagedPane } from './pane-manager-types'
import { resolveLeafIdForManager, resolvePaneKeyForManager } from './pane-key-resolution'

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
  it('resolves a stable pane key to the current numeric pane id', () => {
    const manager = makeManager({
      numericPaneId: 7,
      panes: [{ id: 7, leafId: LEAF_ID as never }]
    })

    expect(resolvePaneKeyForManager('tab-1', PANE_KEY, manager)).toEqual({
      status: 'resolved',
      paneKey: PANE_KEY,
      leafId: LEAF_ID,
      numericPaneId: 7
    })
  })

  it('rejects malformed, legacy numeric, and wrong-tab pane keys as invalid', () => {
    const manager = makeManager({
      numericPaneId: 1,
      panes: [{ id: 1, leafId: LEAF_ID as never }]
    })

    expect(resolvePaneKeyForManager('tab-1', 'tab-1:1', manager)).toMatchObject({
      status: 'unresolved',
      reason: 'invalid'
    })
    expect(resolvePaneKeyForManager('tab-1', makePaneKey('tab-2', LEAF_ID), manager)).toMatchObject(
      {
        status: 'unresolved',
        reason: 'invalid'
      }
    )
  })

  it('reports confirmed-missing when the committed leaf has no live pane', () => {
    const manager = makeManager({ numericPaneId: null, panes: [] })

    expect(resolvePaneKeyForManager('tab-1', PANE_KEY, manager)).toEqual({
      status: 'unresolved',
      paneKey: PANE_KEY,
      leafId: LEAF_ID,
      reason: 'confirmed-missing'
    })
  })

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
