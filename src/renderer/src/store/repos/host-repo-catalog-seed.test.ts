import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../slices/store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'
import type { HostRepoCatalogSnapshot } from '../../../../shared/host-repo-catalog-snapshot'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const HOST = 'runtime:env-wsl'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local/orca',
  displayName: 'orca',
  badgeColor: '#22c55e',
  addedAt: 1
}
const helloWorld = {
  id: 'hello',
  path: '/home/me/Hello-World',
  displayName: 'Hello-World',
  badgeColor: '#737373',
  addedAt: 2,
  kind: 'git' as const
}
const django = { ...helloWorld, id: 'django', path: '/home/me/django', displayName: 'django' }
const notes = {
  ...helloWorld,
  id: 'notes',
  path: '/home/me/notes',
  displayName: 'notes',
  kind: 'folder' as const
}

const saved: Record<string, HostRepoCatalogSnapshot> = {
  'env-wsl': { repos: [helloWorld, django, notes] }
}

const listHostCatalogSnapshots = vi.fn()
const runtimeCall = vi.fn()
const runtimeGetStatus = vi.fn()
const wslApi = { listDistros: vi.fn(), startHost: vi.fn(), getHostStatus: vi.fn() }
let hostRepos: unknown[] | 'stopped' = 'stopped'

function hostRows(repos: readonly Repo[]): { id: string; kind?: string }[] {
  return repos
    .filter((repo) => repo.executionHostId === HOST)
    .map((repo) => ({ id: repo.id, ...(repo.kind ? { kind: repo.kind } : {}) }))
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  hostRepos = 'stopped'
  listHostCatalogSnapshots.mockResolvedValue(structuredClone(saved))
  runtimeCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    if (hostRepos === 'stopped') {
      return {
        id: args.method,
        ok: false,
        error: { code: 'wsl_distro_stopped', message: 'The distro is stopped.' },
        _meta: { runtimeId: 'unknown' }
      }
    }
    const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
    if (compatible) {
      return compatible
    }
    return {
      id: args.method,
      ok: true,
      result: args.method === 'repo.list' ? { repos: structuredClone(hostRepos) } : {},
      _meta: { runtimeId: 'runtime-wsl' }
    }
  })
  vi.stubGlobal('window', {
    api: {
      repos: { list: vi.fn().mockResolvedValue([localRepo]), listHostCatalogSnapshots },
      projects: {
        list: vi.fn().mockResolvedValue([]),
        listHostSetups: vi.fn().mockResolvedValue([])
      },
      projectGroups: { list: vi.fn().mockResolvedValue([]) },
      folderWorkspaces: { list: vi.fn().mockResolvedValue([]) },
      runtimeEnvironments: {
        call: runtimeCall,
        getStatus: runtimeGetStatus,
        list: vi.fn().mockResolvedValue([{ id: 'env-wsl', name: 'orca-demo' }])
      },
      wsl: wslApi
    },
    dispatchEvent: vi.fn()
  })
})

describe('saved WSL host project lists', () => {
  it('lets a live list requested before the seed landed still drop a deleted project', async () => {
    const store = createTestStore()
    hostRepos = [helloWorld]
    let markRequested: () => void = () => undefined
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve
    })
    let releaseAnswer: () => void = () => undefined
    const answerReleased = new Promise<void>((resolve) => {
      releaseAnswer = resolve
    })
    const answerLive = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'repo.list') {
        markRequested()
        await answerReleased
      }
      return answerLive?.(args)
    })

    const fetching = store.getState().fetchReposForAllHosts()
    await requested
    await store.getState().seedReposFromHostCatalogSnapshots()
    expect(hostRows(store.getState().repos).map((row) => row.id)).toEqual([
      'hello',
      'django',
      'notes'
    ])

    releaseAnswer()
    await fetching
    expect(hostRows(store.getState().repos).map((row) => row.id)).toEqual(['hello'])
  })
})
