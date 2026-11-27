import { describe, expect, it } from 'vitest'
import { decodeRailListState, selectRailListState } from './app-rail-list-state'

describe('selectRailListState', () => {
  it('marks Workspaces or Activity current only on the terminal view', () => {
    expect(
      decodeRailListState(selectRailListState({ activeView: 'terminal', sidebarBody: 'agents' }))
    ).toEqual({ workspacesActive: false, activityActive: true, listShowsWorkspaces: false })
    expect(
      decodeRailListState(selectRailListState({ activeView: 'automations', sidebarBody: 'agents' }))
        .activityActive
    ).toBe(false)
  })

  it('marks Workspaces current when the list shows workspaces', () => {
    const state = decodeRailListState(
      selectRailListState({ activeView: 'terminal', sidebarBody: 'workspaces' })
    )
    expect(state).toEqual({
      workspacesActive: true,
      activityActive: false,
      listShowsWorkspaces: true
    })
  })
})
