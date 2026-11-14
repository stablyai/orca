import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../testing/app-store-test-fixture'
afterEach(() => vi.unstubAllGlobals())
import { createProjectGroup } from '../../../../shared/project-groups'
import { projectGroupHookTrustKey } from '../../../../shared/workspace-hook-owner'
import { hydrateTrustedOrcaHooks } from '../slices/ui/ui-slice-hydration-sanitizers'

const list = vi.fn()
beforeEach(() => {
  vi.stubGlobal('window', { api: { projectGroups: { list } } })
})

describe('group hook trust owner lifetime', () => {
  it('survives hydration until its own host returns an authoritative group catalog', async () => {
    const local = {
      ...createProjectGroup({
        name: 'Local',
        parentPath: '/local',
        createdFrom: 'folder-scan',
        tabOrder: 0
      }),
      id: 'same',
      executionHostId: 'local' as const
    }
    const remote = { ...local, executionHostId: 'runtime:remote' as const }
    const localKey = projectGroupHookTrustKey(local)
    const remoteKey = projectGroupHookTrustKey(remote)
    const entry = { setup: { contentHash: 'approved', approvedAt: 1 } }
    const trusted = hydrateTrustedOrcaHooks(
      { [localKey]: entry, [remoteKey]: entry },
      new Set(['repo'])
    )
    const store = createTestStore()
    store.setState({ projectGroups: [local, remote], trustedOrcaHooks: trusted })
    list.mockResolvedValue([local])
    await store.getState().fetchProjectGroups({ runtimeEnvironmentId: null })
    expect(store.getState().trustedOrcaHooks).toEqual({ [localKey]: entry, [remoteKey]: entry })
    list.mockResolvedValue([])
    await store.getState().fetchProjectGroups({ runtimeEnvironmentId: null })
    expect(store.getState().trustedOrcaHooks).toEqual({ [remoteKey]: entry })
  })
})
