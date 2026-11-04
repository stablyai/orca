import { describe, expect, it } from 'vitest'
import { omitPairingLocalUiFields } from './pairing-local-ui-fields'

describe('pairing-local UI fields', () => {
  it('omits every member and keeps everything else', () => {
    const state = {
      hideWorkspacesFromOtherDevices: true,
      manualRepoOrder: [{ hostId: 'local' as const, repoId: 'repo-a' }],
      workspaceHostOrder: ['local' as const],
      showAgentModels: false,
      sidebarWidth: 280,
      activeView: 'tasks' as const
    }

    expect(omitPairingLocalUiFields(state)).toEqual({ sidebarWidth: 280, activeView: 'tasks' })
  })

  // Present undefined still looks like a clear operation to receivers; drop the key itself.
  it('drops a member present with an undefined value', () => {
    expect(
      Object.keys(omitPairingLocalUiFields({ manualRepoOrder: undefined, sidebarWidth: 280 }))
    ).toEqual(['sidebarWidth'])
  })
})
