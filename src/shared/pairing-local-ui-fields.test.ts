import { describe, expect, it } from 'vitest'
import { omitPairingLocalUiFields, PAIRING_LOCAL_UI_FIELDS } from './pairing-local-ui-fields'

describe('pairing-local UI fields', () => {
  // Host RPC and web-preload seams are spread out; a census catches new fields without complete boundary wiring.
  it('census: the set is exactly the fields no pairing may exchange', () => {
    expect([...PAIRING_LOCAL_UI_FIELDS]).toEqual([
      'automationHostFilter',
      'hideWorkspacesFromOtherDevices',
      'manualRepoOrder',
      'workspaceHostOrder',
      'sidebarOpen',
      'agentsVisibleHostIds',
      'agentsFilterRepoIds',
      'agentsHideWorkspacesFromOtherDevices',
      'agentsHideAutomationGeneratedWorkspaces',
      'agentsHideCliCreatedWorkspaces',
      'agentsShowChildAgents',
      'agentsCompactMode',
      'agentsShowSearch',
      'agentsReadFilter',
      'agentsGroupBy',
      'activityClearedAtByPaneKey',
      'manuallyUnreadTurnsByPaneKey'
    ])
  })

  it('omits every member and keeps everything else', () => {
    const state = {
      hideWorkspacesFromOtherDevices: true,
      manualRepoOrder: [{ hostId: 'local' as const, repoId: 'repo-a' }],
      workspaceHostOrder: ['local' as const],
      sidebarWidth: 280,
      activeView: 'tasks' as const
    }

    expect(omitPairingLocalUiFields(state)).toEqual({ sidebarWidth: 280, activeView: 'tasks' })
  })

  it('leaves a payload that carries no member untouched', () => {
    const state = { sidebarWidth: 280 }

    expect(omitPairingLocalUiFields(state)).toEqual(state)
  })

  // Present undefined still looks like a clear operation to receivers; drop the key itself.
  it('drops a member present with an undefined value', () => {
    expect(
      Object.keys(omitPairingLocalUiFields({ manualRepoOrder: undefined, sidebarWidth: 280 }))
    ).toEqual(['sidebarWidth'])
  })
})
