import { describe, it, expect } from 'vitest'
import { reconcileTabOrder } from './reconcile-order'
import { buildOrderedTabItems, findActiveVisibleTabId } from './tab-bar-item-model'
import type { Tab } from '../../../../shared/tab-types'

describe('reconcileTabOrder', () => {
  it('returns all IDs when no stored order exists', () => {
    expect(reconcileTabOrder(undefined, ['t1', 't2'], ['e1'])).toEqual(['t1', 't2', 'e1'])
  })

  it('preserves stored order for existing items', () => {
    expect(reconcileTabOrder(['e1', 't1'], ['t1'], ['e1'])).toEqual(['e1', 't1'])
  })

  it('appends new items at the end', () => {
    expect(reconcileTabOrder(['t1'], ['t1', 't2'], ['e1'])).toEqual(['t1', 't2', 'e1'])
  })

  it('drops stored IDs that no longer exist', () => {
    expect(reconcileTabOrder(['gone', 't1'], ['t1'], [])).toEqual(['t1'])
  })

  it('deduplicates IDs that appear in both terminal and editor lists', () => {
    // Edge case: same ID in both lists should only appear once
    expect(reconcileTabOrder(undefined, ['x'], ['x'])).toEqual(['x'])
  })

  it('handles empty inputs', () => {
    expect(reconcileTabOrder(undefined, [], [])).toEqual([])
    expect(reconcileTabOrder([], [], [])).toEqual([])
  })

  it('maintains interleaved stored order across types', () => {
    const stored = ['t1', 'e1', 't2', 'e2']
    expect(reconcileTabOrder(stored, ['t1', 't2'], ['e1', 'e2'])).toEqual(['t1', 'e1', 't2', 'e2'])
  })

  it('keeps room tabs in the same persisted order as workspace tabs', () => {
    expect(
      reconcileTabOrder(['t1', 'room-1', 'e1'], ['t1'], ['e1'], [], [], [], ['room-1'])
    ).toEqual(['t1', 'room-1', 'e1'])
  })

  it('projects and activates a room through the unified tab strip', () => {
    const room = {
      id: 'room-tab',
      groupId: 'group-1',
      contentType: 'room',
      entityId: 'room-1',
      label: 'Room'
    } as Tab
    const items = buildOrderedTabItems({
      terminalIds: [],
      editorFileIds: [],
      browserTabIds: [],
      simulatorTabIds: [],
      agentSessionTabIds: [],
      roomTabIds: [room.id],
      terminalMap: new Map(),
      editorMap: new Map(),
      browserMap: new Map(),
      agentSessionMap: new Map(),
      unifiedTabByVisibleId: new Map([[room.id, room]])
    })

    expect(items).toMatchObject([{ type: 'room', id: room.id, unifiedTabId: room.id }])
    expect(findActiveVisibleTabId(items, { activeTabId: null, activeGroupTabId: room.id })).toBe(
      room.id
    )
  })
})
