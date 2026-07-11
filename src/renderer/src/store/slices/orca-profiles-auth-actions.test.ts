import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type {
  ConnectCurrentOrcaProfileResult,
  CreateCloudLinkedOrcaProfileResult,
  OrcaProfileAuthStatus,
  OrcaProfileListState,
  RefreshCurrentOrcaProfileAuthResult,
  SelectOrcaProfileOrgResult,
  SignOutCurrentOrcaProfileResult
} from '../../../../shared/orca-profiles'

const listState: OrcaProfileListState = {
  activeProfileId: 'local-default',
  profiles: [
    {
      id: 'local-default',
      name: 'Personal',
      avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
      kind: 'local',
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1
    }
  ]
}

const localAuthStatus: OrcaProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: false,
  state: 'unconfigured',
  persistence: 'none'
}

const connectedCloud = {
  cloudProfileId: 'cloud-profile-1',
  userId: 'user-1',
  email: 'nina@example.com',
  linkedAt: 3
}

const connectedOrganizations = [
  { orgId: 'org-1', name: 'Acme', role: 'Admin' },
  { orgId: 'org-2', name: 'Personal' }
]

const connectedAuthStatus: OrcaProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: true,
  state: 'connected',
  persistence: 'encrypted',
  cloud: connectedCloud,
  organizations: connectedOrganizations,
  capabilities: {
    flags: { share: true },
    refreshedAt: 4
  }
}

const orcaProfilesApi = {
  list: vi.fn(),
  authStatus: vi.fn(),
  createLocal: vi.fn(),
  createCloudLinked: vi.fn(),
  connectCurrent: vi.fn(),
  refreshAuth: vi.fn(),
  signOutCurrent: vi.fn(),
  selectOrg: vi.fn(),
  switchProfile: vi.fn(),
  transferProject: vi.fn()
}

describe('orca profile auth actions slice', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    orcaProfilesApi.authStatus.mockResolvedValue(localAuthStatus)
    vi.stubGlobal('window', {
      api: {
        orcaProfiles: orcaProfilesApi
      }
    })
  })

  it('connects the current profile and stores returned cloud metadata', async () => {
    const connectedProfiles = [
      {
        ...listState.profiles[0],
        kind: 'cloud-linked' as const,
        cloud: connectedAuthStatus.cloud
      }
    ]
    const result: ConnectCurrentOrcaProfileResult = {
      status: 'connected',
      auth: connectedAuthStatus,
      activeProfileId: 'local-default',
      profiles: connectedProfiles
    }
    orcaProfilesApi.connectCurrent.mockResolvedValue(result)
    const store = createTestStore()

    const pending = store.getState().connectCurrentOrcaProfile()

    expect(store.getState().orcaProfileConnecting).toBe(true)
    await expect(pending).resolves.toEqual(result)
    expect(store.getState().orcaProfileConnecting).toBe(false)
    expect(store.getState().orcaProfileAuthStatus).toEqual(connectedAuthStatus)
    expect(store.getState().orcaProfiles).toEqual(connectedProfiles)
  })

  it('refreshes current profile auth and stores fresh capability flags', async () => {
    const refreshedAuthStatus: OrcaProfileAuthStatus = {
      ...connectedAuthStatus,
      capabilities: {
        flags: { share: false, team: true },
        refreshedAt: 8
      }
    }
    const result: RefreshCurrentOrcaProfileAuthResult = {
      status: 'refreshed',
      auth: refreshedAuthStatus,
      activeProfileId: 'local-default',
      profiles: [
        {
          ...listState.profiles[0],
          kind: 'cloud-linked',
          cloud: refreshedAuthStatus.cloud
        }
      ]
    }
    orcaProfilesApi.refreshAuth.mockResolvedValue(result)
    const store = createTestStore()

    await expect(store.getState().refreshCurrentOrcaProfileAuth()).resolves.toEqual(result)
    expect(orcaProfilesApi.refreshAuth).toHaveBeenCalledOnce()
    expect(store.getState().orcaProfileAuthStatus).toEqual(refreshedAuthStatus)
    expect(store.getState().orcaProfiles).toEqual(result.profiles)
  })

  it('creates a cloud-linked profile and stores the returned profile list', async () => {
    const cloudProfile = {
      id: 'cloud-acme',
      name: 'Acme',
      avatar: { kind: 'initials' as const, initials: 'A', color: 'neutral' as const },
      kind: 'cloud-linked' as const,
      createdAt: 5,
      updatedAt: 5,
      lastOpenedAt: 5,
      cloud: {
        ...connectedCloud,
        cloudProfileId: 'cloud-profile-2',
        activeOrgId: 'org-1',
        activeOrgName: 'Acme'
      }
    }
    const result: CreateCloudLinkedOrcaProfileResult = {
      status: 'created',
      auth: connectedAuthStatus,
      activeProfileId: 'local-default',
      profiles: [...listState.profiles, cloudProfile],
      profile: cloudProfile
    }
    orcaProfilesApi.createCloudLinked.mockResolvedValue(result)
    const store = createTestStore()

    await expect(
      store.getState().createCloudLinkedOrcaProfile({ orgId: 'org-1', name: 'Acme' })
    ).resolves.toEqual(result)
    expect(orcaProfilesApi.createCloudLinked).toHaveBeenCalledWith({
      orgId: 'org-1',
      name: 'Acme'
    })
    expect(store.getState().orcaProfiles).toEqual(result.profiles)
  })

  it('signs out the current profile without dropping local profile data', async () => {
    const result: SignOutCurrentOrcaProfileResult = {
      status: 'signed-out',
      auth: localAuthStatus,
      activeProfileId: 'local-default',
      profiles: listState.profiles
    }
    orcaProfilesApi.signOutCurrent.mockResolvedValue(result)
    const store = createTestStore()

    await expect(store.getState().signOutCurrentOrcaProfile()).resolves.toEqual(result)
    expect(store.getState().orcaProfileAuthStatus).toEqual(localAuthStatus)
    expect(store.getState().orcaProfiles).toEqual(listState.profiles)
  })

  it('selects a cloud organization and refreshes auth state', async () => {
    const selectedAuthStatus: OrcaProfileAuthStatus = {
      ...connectedAuthStatus,
      cloud: {
        ...connectedCloud,
        activeOrgId: 'org-1',
        activeOrgName: 'Acme'
      }
    }
    const result: SelectOrcaProfileOrgResult = {
      status: 'selected',
      auth: selectedAuthStatus,
      activeProfileId: 'local-default',
      profiles: [
        {
          ...listState.profiles[0],
          kind: 'cloud-linked',
          cloud: selectedAuthStatus.cloud
        }
      ]
    }
    orcaProfilesApi.selectOrg.mockResolvedValue(result)
    const store = createTestStore()

    await expect(store.getState().selectOrcaProfileOrg('org-1')).resolves.toEqual(result)
    expect(orcaProfilesApi.selectOrg).toHaveBeenCalledWith({ orgId: 'org-1' })
    expect(store.getState().orcaProfileAuthStatus).toEqual(selectedAuthStatus)
    expect(store.getState().orcaProfileAuthStatus?.organizations).toEqual(connectedOrganizations)
  })
})
