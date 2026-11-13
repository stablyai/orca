import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CloudWorkspaceResult,
  OrcaCloudWorkspaceApi
} from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import {
  archiveCloudWorkspace,
  restartCloudWorkspace,
  unarchiveCloudWorkspace
} from './orca-cloud-workspace-actions'
import {
  dismissCloudOom,
  getCloudWorkspaceSnapshot,
  isCloudWorkspaceArchived,
  noteCloudOom,
  noteCloudWakeProgress,
  refreshCloudWorkspaceIds,
  refreshCloudWorkspaceStatus,
  seedCloudWorkspaceSnapshot
} from './orca-cloud-workspace-store'

const ready: HostedWorkspaceStatus = {
  state: 'ready',
  metrics: null,
  uptimeMs: 1000,
  usage: { totalMs: 1000, centsPerHour: 75, costCents: 0 },
  archive: null,
  checkedAt: 1
}
const ok = <T>(value: T): CloudWorkspaceResult<T> => ({ ok: true, value })

function stubApi(overrides: Partial<OrcaCloudWorkspaceApi> = {}): OrcaCloudWorkspaceApi {
  const bridge: OrcaCloudWorkspaceApi = {
    getStatus: vi.fn(async () => ok(ready)),
    restart: vi.fn(async () => ok(null)),
    archive: vi.fn(async () => ok(null)),
    unarchive: vi.fn(async () => ok(null)),
    getArchive: vi.fn(async () => ok(null)),
    listCloudWorkspaceIds: vi.fn(async () => ['a', 'b']),
    getConfig: vi.fn(async () => null),
    connectGitHub: vi.fn(async () => ok(null)),
    getGitHubUser: vi.fn(async () => ok({ connected: false as const })),
    connectGitHubUser: vi.fn(async () => ok(null)),
    gitHubUserConnectLink: vi.fn(async () => ok('https://github.com/login/oauth/authorize')),
    disconnectGitHubUser: vi.fn(async () => ok({ connected: false as const })),
    getRepoAccess: vi.fn(async () =>
      ok({ access: 'granted' as const, owner: 'a', repo: 'https://github.com/a/b' })
    ),
    listGitHubRepositories: vi.fn(async () => ok({ repositories: [], nextCursor: null })),
    createFromGitHub: vi.fn(async () => ok({ sandboxId: 'sbx' })),
    onWakeProgress: vi.fn(() => () => {}),
    onOom: vi.fn(() => () => {}),
    ...overrides
  }
  vi.stubGlobal('window', { api: { orcaCloudWorkspace: bridge } })
  return bridge
}

beforeEach(() => seedCloudWorkspaceSnapshot({}))
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('orca cloud workspace store', () => {
  it('learns cloud ids and reads each new workspace once', async () => {
    const bridge = stubApi()
    await refreshCloudWorkspaceIds()
    expect([...getCloudWorkspaceSnapshot().ids]).toEqual(['a', 'b'])
    expect(getCloudWorkspaceSnapshot().status.a?.status?.state).toBe('ready')
    expect(bridge.getStatus).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent status reads into one follow-up and keeps the last good status on error', async () => {
    const bridge = stubApi()
    // Three asks while one read is in flight: one follow-up read, not three.
    await Promise.all([
      refreshCloudWorkspaceStatus('a'),
      refreshCloudWorkspaceStatus('a'),
      refreshCloudWorkspaceStatus('a')
    ])
    expect(bridge.getStatus).toHaveBeenCalledTimes(2)
    bridge.getStatus = vi.fn(async () => ({
      ok: false as const,
      code: 'unavailable' as const,
      message: 'down'
    }))
    await refreshCloudWorkspaceStatus('a')
    const entry = getCloudWorkspaceSnapshot().status.a!
    expect(entry.status?.state).toBe('ready')
    expect(entry.error).toBe('down')
    expect(entry.loading).toBe(false)
  })

  it('forgets a workspace the main process says is not cloud', async () => {
    stubApi({
      getStatus: vi.fn(async () => ({
        ok: false as const,
        code: 'not_cloud' as const,
        message: 'no'
      }))
    })
    seedCloudWorkspaceSnapshot({ ids: new Set(['a']) })
    await refreshCloudWorkspaceStatus('a')
    expect(getCloudWorkspaceSnapshot().ids.has('a')).toBe(false)
  })

  it('re-reads after an in-flight read that started before the wake finished (no stale Asleep)', async () => {
    let release: () => void = () => {}
    const states: HostedWorkspaceStatus['state'][] = ['sleeping', 'ready']
    const bridge = stubApi({
      getStatus: vi.fn(async () => {
        const state = states.shift()!
        if (state === 'sleeping') {
          await new Promise<void>((resolve) => (release = resolve))
        }
        return ok({ ...ready, state })
      })
    })
    const first = refreshCloudWorkspaceStatus('a')
    // The wake becomes ready while the first (pre-wake) read is still out.
    const afterWake = refreshCloudWorkspaceStatus('a')
    release()
    await Promise.all([first, afterWake])
    expect(bridge.getStatus).toHaveBeenCalledTimes(2)
    expect(getCloudWorkspaceSnapshot().status.a?.status?.state).toBe('ready')
  })

  it('archives after the ordinary sleep, and marks pending while it runs', async () => {
    const bridge = stubApi()
    const order: string[] = []
    const sleep = vi.fn(async () => {
      order.push('sleep')
      expect(getCloudWorkspaceSnapshot().pending.a).toBe('archive')
    })
    bridge.archive = vi.fn(async () => (order.push('archive'), ok(null)))
    await archiveCloudWorkspace('a', { sleep })
    expect(order).toEqual(['sleep', 'archive'])
    expect(getCloudWorkspaceSnapshot().pending.a).toBeUndefined()
  })

  it('does not archive when the sleep did not finish (the sandbox would keep running)', async () => {
    const bridge = stubApi()
    const result = await archiveCloudWorkspace('a', {
      sleep: async () => [{ completed: false }]
    })
    expect(result).toMatchObject({ ok: false, code: 'failed' })
    expect(bridge.archive).not.toHaveBeenCalled()
    expect(getCloudWorkspaceSnapshot().pending.a).toBeUndefined()
  })

  it('unarchives, clears the archived status, then runs the wake path', async () => {
    stubApi()
    seedCloudWorkspaceSnapshot({
      ids: new Set(['a']),
      status: {
        a: {
          status: { ...ready, state: 'archived', archive: { archivedAt: 1, expiresAt: 2 } },
          loading: false,
          error: null,
          fetchedAt: 1
        }
      }
    })
    expect(isCloudWorkspaceArchived('a')).toBe(true)
    const wake = vi.fn(async () => {
      expect(isCloudWorkspaceArchived('a')).toBe(false)
    })
    await unarchiveCloudWorkspace('a', { wake })
    expect(wake).toHaveBeenCalledWith('a')
  })

  it('tracks wake progress (adding the id) and dismisses OOM notices up to the seen count', async () => {
    stubApi()
    noteCloudWakeProgress({
      workspaceId: 'c',
      phase: 'waking',
      source: 'message',
      startedAt: 1,
      at: 2
    })
    expect(getCloudWorkspaceSnapshot().ids.has('c')).toBe(true)
    noteCloudOom({ workspaceId: 'c', oomKills: 1, victim: 'node', at: 3 })
    dismissCloudOom('c')
    expect(getCloudWorkspaceSnapshot().oomDismissed.c).toBe(1)
  })

  it('a successful restart clears the OOM notice', async () => {
    stubApi()
    noteCloudOom({ workspaceId: 'a', oomKills: 2, victim: null, at: 1 })
    await restartCloudWorkspace('a')
    expect(getCloudWorkspaceSnapshot().oomDismissed.a).toBe(2)
  })
})
