import { describe, expect, it } from 'vitest'
import { omitPairingLocalUiFields, PAIRING_LOCAL_UI_FIELDS } from './pairing-local-ui-fields'

describe('pairing-local UI fields', () => {
  // Why a census: the seams that honor this set are spread across the host RPC and the web
  // preload, so a field added here without wiring every seam would otherwise ship silently.
  it('census: the set is exactly the fields no pairing may exchange', () => {
    expect([...PAIRING_LOCAL_UI_FIELDS]).toEqual([
      'automationHostFilter',
      'hideWorkspacesFromOtherDevices',
      'manualRepoOrder',
      'workspaceHostOrder',
      'agentsVisibleHostIds',
      'agentsFilterRepoIds',
      'agentsShowChildAgents',
      'agentsCompactMode',
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

  // A member explicitly set to undefined must still be removed, not forwarded as a present key
  // that a receiver would read as "cleared".
  it('drops a member present with an undefined value', () => {
    expect(
      Object.keys(omitPairingLocalUiFields({ manualRepoOrder: undefined, sidebarWidth: 280 }))
    ).toEqual(['sidebarWidth'])
  })
})
