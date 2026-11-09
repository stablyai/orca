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

  it('coalesces concurrent status reads and keeps the last good status on error', async () => {
    const bridge = stubApi()
    await Promise.all([refreshCloudWorkspaceStatus('a'), refreshCloudWorkspaceStatus('a')])
    expect(bridge.getStatus).toHaveBeenCalledTimes(1)
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
