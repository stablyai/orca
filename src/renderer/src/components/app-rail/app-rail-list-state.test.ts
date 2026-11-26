import { describe, expect, it } from 'vitest'
import { decodeRailListState, selectRailListState } from './app-rail-list-state'

describe('selectRailListState', () => {
  it('marks Workspaces or Activity current only on the terminal view', () => {
    expect(
      decodeRailListState(
        selectRailListState({ activeView: 'terminal', sidebarBody: 'agents', sidebarOpen: true })
      )
    ).toEqual({
      workspacesActive: false,
      activityActive: true,
      listShowsWorkspaces: false,
      listRowsMounted: true
    })
    expect(
      decodeRailListState(
        selectRailListState({ activeView: 'automations', sidebarBody: 'agents', sidebarOpen: true })
      ).activityActive
    ).toBe(false)
  })

  it('reports the rows unmounted only for the user collapse, so the dot does no work then', () => {
    const state = decodeRailListState(
      selectRailListState({ activeView: 'terminal', sidebarBody: 'workspaces', sidebarOpen: false })
    )
    expect(state.workspacesActive).toBe(true)
    expect(state.listRowsMounted).toBe(false)
  })
})
