import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CloudWorkspaceStatus,
  OrcaCloudWorkspaceApi
} from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import {
  dismissCloudGitSetup,
  getCloudGitSetupState,
  seedCloudGitSetupState
} from './cloud-git-setup-store'
import {
  getCloudWorkspaceSnapshot,
  noteCloudWakeProgress,
  refreshCloudWorkspaceStatus,
  seedCloudWorkspaceSnapshot
} from './orca-cloud-workspace-store'

const status = (
  state: HostedWorkspaceStatus['state'],
  gitSetupFailed = false
): CloudWorkspaceStatus => ({
  ...(gitSetupFailed ? { gitSetupFailed: true as const } : {}),
  state,
  metrics: null,
  uptimeMs: null,
  usage: { totalMs: 0, centsPerHour: 75, costCents: 0 },
  archive: null,
  checkedAt: 1
})

function stub(
  getStatus: OrcaCloudWorkspaceApi['getStatus'],
  ids: string[] = []
): OrcaCloudWorkspaceApi {
  const unused = async (): Promise<never> => {
    throw new Error('not used by these tests')
  }
  const bridge: OrcaCloudWorkspaceApi = {
    getStatus: vi.fn(getStatus),
    restart: vi.fn(unused),
    archive: vi.fn(unused),
    unarchive: vi.fn(unused),
    getArchive: vi.fn(unused),
    listCloudWorkspaceIds: vi.fn(async () => ids),
    getConfig: vi.fn(async () => null),
    connectGitHub: vi.fn(unused),
    getGitHubUser: vi.fn(unused),
    connectGitHubUser: vi.fn(unused),
    gitHubUserConnectLink: vi.fn(unused),
    disconnectGitHubUser: vi.fn(unused),
    getRepoAccess: vi.fn(unused),
    gitHubInstallRights: vi.fn(unused),
    listGitHubRepositories: vi.fn(unused),
    createFromGitHub: vi.fn(unused),
    retryCancelledCreate: vi.fn(unused),
    onWakeProgress: vi.fn(() => () => {}),
    onOom: vi.fn(() => () => {})
  }
  vi.stubGlobal('window', { api: { orcaCloudWorkspace: bridge } })
  return bridge
}

beforeEach(() => {
  seedCloudWorkspaceSnapshot({})
  seedCloudGitSetupState({})
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const restartReady = (workspaceId: string): void => {
  const base = { workspaceId, source: 'restart' as const, startedAt: 10 }
  noteCloudWakeProgress({ ...base, phase: 'waking', at: 11 })
  noteCloudWakeProgress({ ...base, phase: 'ready', at: 12 })
}

describe('GIT-SETUP state in the workspace store', () => {
  it('carries the failed git setup from the status read', async () => {
    stub(async () => ({ ok: true, value: status('ready', true) }))
    await refreshCloudWorkspaceStatus('a')
    expect(getCloudWorkspaceSnapshot().status.a?.status?.gitSetupFailed).toBe(true)
  })

  it('a restart that leaves git setup failed counts as the retry that didn’t fix it', async () => {
    stub(async () => ({ ok: true, value: status('ready', true) }))
    await refreshCloudWorkspaceStatus('a')
    restartReady('a')
    // Not before the fresh read: the old status must not flash "didn't fix it".
    expect(getCloudGitSetupState().restarted.a).toBeUndefined()
    await vi.waitFor(() => expect(getCloudGitSetupState().restarted.a).toBe(true))
  })

  it('a restart that fixed it leaves no retry mark', async () => {
    const bridge = stub(async () => ({ ok: true, value: status('ready', true) }))
    await refreshCloudWorkspaceStatus('a')
    bridge.getStatus = vi.fn(async () => ({ ok: true as const, value: status('ready') }))
    restartReady('a')
    await vi.waitFor(() => expect(getCloudWorkspaceSnapshot().wake.a).toBeUndefined())
    expect(getCloudWorkspaceSnapshot().status.a?.status?.gitSetupFailed).toBeUndefined()
    expect(getCloudGitSetupState().restarted.a).toBeUndefined()
  })

  it('a later read with git working clears the retry mark', async () => {
    const bridge = stub(async () => ({ ok: true, value: status('ready', true) }))
    seedCloudGitSetupState({ restarted: { a: true } })
    bridge.getStatus = vi.fn(async () => ({ ok: true as const, value: status('ready') }))
    await refreshCloudWorkspaceStatus('a')
    expect(getCloudGitSetupState().restarted.a).toBeUndefined()
  })

  it('dismissal lasts until the workspace wakes', async () => {
    stub(async () => ({ ok: true, value: status('ready', true) }))
    dismissCloudGitSetup('a')
    expect(getCloudGitSetupState().dismissed.a).toBe(true)
    const base = { workspaceId: 'a', source: 'open' as const, startedAt: 10 }
    noteCloudWakeProgress({ ...base, phase: 'waking', at: 11 })
    expect(getCloudGitSetupState().dismissed.a).toBe(true)
    noteCloudWakeProgress({ ...base, phase: 'ready', at: 12 })
    expect(getCloudGitSetupState().dismissed.a).toBeUndefined()
  })
})
