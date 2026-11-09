import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudWorkspaceApi } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import {
  dismissCloudWake,
  getCloudWorkspaceSnapshot,
  isCloudWorkspaceArchivedFresh,
  noteCloudWakeProgress,
  refreshCloudWorkspaceIds,
  seedCloudWorkspaceSnapshot
} from './orca-cloud-workspace-store'

const status = (state: HostedWorkspaceStatus['state']): HostedWorkspaceStatus => ({
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
    onWakeProgress: vi.fn(() => () => {}),
    onOom: vi.fn(() => () => {})
  }
  vi.stubGlobal('window', { api: { orcaCloudWorkspace: bridge } })
  return bridge
}

beforeEach(() => seedCloudWorkspaceSnapshot({}))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('wake state and archive guard', () => {
  it('a ready wake is removed once the status is re-read, so nothing keeps ticking', async () => {
    stub(async () => ({ ok: true, value: status('ready') }))
    const base = { workspaceId: 'a', source: 'message' as const, startedAt: 10 }
    noteCloudWakeProgress({ ...base, phase: 'waking', at: 11 })
    noteCloudWakeProgress({ ...base, phase: 'ready', source: 'open', at: 12 })
    // The source the wake started with is kept for later phases.
    expect(getCloudWorkspaceSnapshot().wake.a?.source).toBe('message')
    await vi.waitFor(() => expect(getCloudWorkspaceSnapshot().wake.a).toBeUndefined())
    expect(getCloudWorkspaceSnapshot().status.a?.status?.state).toBe('ready')
  })

  it('a failed wake stays until dismissed', async () => {
    stub(async () => ({ ok: true, value: status('sleeping') }))
    noteCloudWakeProgress({
      workspaceId: 'a',
      phase: 'failed',
      source: 'open',
      startedAt: 1,
      at: 2
    })
    expect(getCloudWorkspaceSnapshot().wake.a?.phase).toBe('failed')
    dismissCloudWake('a')
    expect(getCloudWorkspaceSnapshot().wake.a).toBeUndefined()
  })

  it('reads a fresh status before deciding a workspace is not archived (cold start, failed read)', async () => {
    const bridge = stub(async () => ({ ok: true, value: status('archived') }))
    expect(await isCloudWorkspaceArchivedFresh('a')).toBe(true)
    expect(bridge.getStatus).toHaveBeenCalledTimes(1)
    // Fresh: no second read.
    expect(await isCloudWorkspaceArchivedFresh('a')).toBe(true)
    expect(bridge.getStatus).toHaveBeenCalledTimes(1)
  })

  it('caps the startup status fan-out at four reads in flight', async () => {
    let inFlight = 0
    let peak = 0
    stub(
      async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 0))
        inFlight--
        return { ok: true, value: status('sleeping') }
      },
      Array.from({ length: 10 }, (_, i) => `w${i}`)
    )
    await refreshCloudWorkspaceIds()
    expect(peak).toBe(4)
    expect(getCloudWorkspaceSnapshot().idsLoaded).toBe(true)
    expect(Object.keys(getCloudWorkspaceSnapshot().status)).toHaveLength(10)
  })
})
