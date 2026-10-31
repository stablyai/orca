import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktreeListResult } from '../../../../shared/worktree/types'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore, makeWorktree, seedStore } from '../slices/store-test-helpers'

const SERVER = toRuntimeExecutionHostId('env-1')

function serverRepo(id: string, path = '/srv/app'): Repo {
  return {
    id,
    path,
    displayName: 'app',
    badgeColor: '#737373',
    addedAt: 1,
    executionHostId: SERVER
  }
}

function serverRow(repoId: string, path = '/srv/app') {
  return makeWorktree({ id: `${repoId}::${path}`, repoId, path, hostId: SERVER })
}

let serverRepos: Repo[] = []
let repoListGate: Promise<void> | null = null
const call = vi.fn(async (args: RuntimeEnvironmentCallRequest) => {
  const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
  if (compatible) {
    return compatible
  }
  if (args.method === 'repo.list') {
    const answer = structuredClone(serverRepos)
    await repoListGate
    return { id: 'rpc-repo.list', ok: true, result: { repos: answer }, _meta: {} }
  }
  return { id: `rpc-${args.method}`, ok: true, result: {}, _meta: { runtimeId: 'remote-runtime' } }
})

describe('a fetched catalog that drops a repo registration', () => {
  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    call.mockClear()
    repoListGate = null
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call, list: vi.fn().mockResolvedValue([]) } },
      dispatchEvent: vi.fn()
    })
  })

  it('drops that host’s rows when the server relists its checkout under a new repo id', async () => {
    const store = createTestStore()
    const localTwin: Repo = { ...serverRepo('old'), path: '/local/app', executionHostId: 'local' }
    const localRow = makeWorktree({
      id: 'old::/local/app',
      repoId: 'old',
      path: '/local/app',
      hostId: 'local'
    })
    const legacyRow = makeWorktree({ id: 'old::/legacy', repoId: 'old', path: '/legacy' })
    const detected: DetectedWorktreeListResult = {
      repoId: 'old',
      authoritative: true,
      source: 'git',
      worktrees: [serverRow('old'), localRow].map((row) => ({
        ...row,
        ownership: 'orca-managed' as const,
        selectedCheckout: true,
        visible: true
      }))
    }
    seedStore(store, {
      repos: [serverRepo('old'), localTwin],
      worktreesByRepo: { old: [serverRow('old'), localRow, legacyRow] },
      detectedWorktreesByRepo: { old: detected }
    })
    serverRepos = [serverRepo('copied')]

    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    const state = store.getState()
    expect(state.repos.map((repo) => `${repo.executionHostId}:${repo.id}`).sort()).toEqual([
      'local:old',
      `${SERVER}:copied`
    ])
    // The local twin keeps its row and the pre-host row it may own; only the server's row goes.
    expect(state.worktreesByRepo.old?.map((worktree) => worktree.id)).toEqual([
      'old::/local/app',
      'old::/legacy'
    ])
    expect(state.detectedWorktreesByRepo.old?.worktrees.map((worktree) => worktree.id)).toEqual([
      'old::/local/app'
    ])
  })

  it('drops the pre-host rows too once no host registers the repo id', async () => {
    const store = createTestStore()
    seedStore(store, {
      repos: [serverRepo('old')],
      worktreesByRepo: {
        old: [
          serverRow('old'),
          makeWorktree({ id: 'old::/legacy', repoId: 'old', path: '/legacy' })
        ]
      }
    })
    serverRepos = [serverRepo('copied')]

    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    expect(store.getState().worktreesByRepo.old).toEqual([])
  })

  it('keeps the rows of a repo added while the catalog was in flight', async () => {
    const store = createTestStore()
    seedStore(store, {
      repos: [serverRepo('kept')],
      worktreesByRepo: { kept: [serverRow('kept')] }
    })
    serverRepos = [serverRepo('kept')]
    const { promise, resolve } = Promise.withResolvers<void>()
    repoListGate = promise

    const fetching = store.getState().fetchRuntimeEnvironmentRepos('env-1')
    // The add lands after the request went out, so the answer cannot list it.
    store.setState((s) => ({
      repos: [...s.repos, serverRepo('added', '/srv/added')],
      worktreesByRepo: { ...s.worktreesByRepo, added: [serverRow('added', '/srv/added')] }
    }))
    resolve()
    await fetching

    expect(store.getState().worktreesByRepo.added?.map((worktree) => worktree.id)).toEqual([
      'added::/srv/added'
    ])
  })
})
