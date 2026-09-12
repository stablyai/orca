import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'

// Why: setWorkspaceStatuses persists via window.api.ui.set; stub it so the
// prune path runs without a real IPC bridge.
const uiSet = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  uiSet.mockClear()
  vi.stubGlobal('window', { api: { ui: { set: uiSet } } })
})

describe('setWorkspaceStatuses prunes filterWorkspaceStatuses', () => {
  it('drops a filter id when its status is deleted from the catalog', () => {
    const store = createTestStore()
    const withCustom = [
      ...cloneDefaultWorkspaceStatuses(),
      { id: 'blocked', label: 'Blocked', color: 'rose', icon: 'ban' }
    ]
    store.setState({
      workspaceStatuses: withCustom,
      filterWorkspaceStatuses: ['blocked', 'completed']
    })

    // Delete the custom "blocked" status.
    store.getState().setWorkspaceStatuses(cloneDefaultWorkspaceStatuses())

    expect(store.getState().filterWorkspaceStatuses).toEqual(['completed'])
    expect(uiSet).toHaveBeenCalledWith(
      expect.objectContaining({ filterWorkspaceStatuses: ['completed'] })
    )
  })

  it('leaves the filter untouched when every selected status survives', () => {
    const store = createTestStore()
    store.setState({
      workspaceStatuses: cloneDefaultWorkspaceStatuses(),
      filterWorkspaceStatuses: ['todo', 'completed']
    })

    store.getState().setWorkspaceStatuses(cloneDefaultWorkspaceStatuses())

    expect(store.getState().filterWorkspaceStatuses).toEqual(['todo', 'completed'])
  })

  it('clears the filter when the sole selected status is removed', () => {
    const store = createTestStore()
    const withCustom = [
      ...cloneDefaultWorkspaceStatuses(),
      { id: 'blocked', label: 'Blocked', color: 'rose', icon: 'ban' }
    ]
    store.setState({ workspaceStatuses: withCustom, filterWorkspaceStatuses: ['blocked'] })

    store.getState().setWorkspaceStatuses(cloneDefaultWorkspaceStatuses())

    expect(store.getState().filterWorkspaceStatuses).toEqual([])
  })
})
