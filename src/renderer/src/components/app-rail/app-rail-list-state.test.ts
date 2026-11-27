import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { decodeRailListState, selectRailListState } from './app-rail-list-state'

function state(
  activeView: 'terminal' | 'automations',
  sidebarBody: 'agents' | 'workspaces',
  botsEnabled = true
): Parameters<typeof selectRailListState>[0] {
  return {
    activeView,
    sidebarBody,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selector reads only these settings.
    settings: { experimentalAppRail: true, botsEnabled } as AppState['settings'],
    orcaProfileAuthStatus: null
  }
}

describe('selectRailListState', () => {
  it('marks Workspaces or Activity current only on the terminal view', () => {
    expect(decodeRailListState(selectRailListState(state('terminal', 'agents')))).toEqual({
      workspacesActive: false,
      activityActive: true,
      listShowsWorkspaces: false,
      activityInbox: true
    })
    expect(
      decodeRailListState(selectRailListState(state('automations', 'agents'))).activityActive
    ).toBe(false)
  })

  it('marks Workspaces current when the list shows workspaces', () => {
    expect(decodeRailListState(selectRailListState(state('terminal', 'workspaces')))).toEqual({
      workspacesActive: true,
      activityActive: false,
      listShowsWorkspaces: true,
      activityInbox: true
    })
  })

  it('has no Activity item with bots off, as the rail was before', () => {
    const decoded = decodeRailListState(selectRailListState(state('terminal', 'agents', false)))
    expect(decoded.activityInbox).toBe(false)
    expect(decoded.activityActive).toBe(false)
    expect(decoded.workspacesActive).toBe(false)
  })
})
