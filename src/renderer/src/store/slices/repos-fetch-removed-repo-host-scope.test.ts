// Session restore can hold placeholder rows for a runtime env under a repo id that also exists
// locally. A local fetch that drops that id may only drop the local host's rows and state.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore, makeTab, makeWorktree } from './store-test-helpers'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'

const keptRepo: Repo = {
  id: 'repo-kept',
  path: '/kept',
  displayName: 'Kept',
  badgeColor: '#000000',
  addedAt: 1,
  executionHostId: 'local'
}
const sharedIdRepo: Repo = { ...keptRepo, id: 'repo-x', path: '/local/x', addedAt: 2 }

const LOCAL_IMPLICIT = 'repo-x::/local/x/wt-implicit'
const LOCAL_EXPLICIT = 'repo-x::/local/x/wt-explicit'
const RUNTIME = 'repo-x::/srv/x/wt'

const reposList = vi.fn()
const ptyKill = vi.fn()

function seededStore(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  const row = (id: string, hostId?: ExecutionHostId) =>
    makeWorktree({
      id,
      repoId: sharedIdRepo.id,
      path: id.slice(id.indexOf('::') + 2),
      ...(hostId ? { hostId } : {})
    })
  const rows = [row(LOCAL_IMPLICIT), row(LOCAL_EXPLICIT, 'local'), row(RUNTIME, 'runtime:env-1')]
  const ids = rows.map((worktree) => worktree.id)
  store.setState({
    repos: [keptRepo, sharedIdRepo],
    worktreesByRepo: { [sharedIdRepo.id]: rows },
    detectedWorktreesByRepo: { [sharedIdRepo.id]: makeDetectedResult(sharedIdRepo.id, rows) },
    tabsByWorktree: Object.fromEntries(
      ids.map((id) => [id, [makeTab({ id: `tab:${id}`, worktreeId: id })]])
    ),
    ptyIdsByTabId: Object.fromEntries(ids.map((id) => [`tab:${id}`, [`pty:${id}`]])),
    activeWorktreeId: RUNTIME,
    activeTabId: `tab:${RUNTIME}`
  })
  return store
}

beforeEach(() => {
  reposList.mockReset()
  ptyKill.mockReset()
  reposList.mockImplementation(async () => [structuredClone(keptRepo)])
  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projects: {
        list: vi.fn().mockResolvedValue([]),
        listHostSetups: vi.fn().mockResolvedValue([])
      },
      pty: { kill: ptyKill },
      runtimeEnvironments: { call: vi.fn() }
    },
    dispatchEvent: vi.fn()
  })
})

describe('local fetchRepos dropping a repo id another host also uses', () => {
  it('drops only the local rows and keeps the runtime row in both worktree maps', async () => {
    const store = seededStore()

    await store.getState().fetchRepos()

    const s = store.getState()
    expect(reposList).toHaveBeenCalledTimes(1)
    expect(s.repos.map((repo) => repo.id)).toEqual([keptRepo.id])
    expect(s.worktreesByRepo[sharedIdRepo.id]?.map((worktree) => worktree.id)).toEqual([RUNTIME])
    expect(
      s.detectedWorktreesByRepo[sharedIdRepo.id]?.worktrees.map((worktree) => worktree.id)
    ).toEqual([RUNTIME])
  })

  it('purges the local rows terminal state and keeps the runtime row tabs and active selection', async () => {
    const store = seededStore()
    const runtimeTabs = store.getState().tabsByWorktree[RUNTIME]

    await store.getState().fetchRepos()

    const s = store.getState()
    expect(s.tabsByWorktree).not.toHaveProperty(LOCAL_IMPLICIT)
    expect(s.tabsByWorktree).not.toHaveProperty(LOCAL_EXPLICIT)
    expect(s.tabsByWorktree[RUNTIME]).toBe(runtimeTabs)
    expect(s.ptyIdsByTabId[`tab:${RUNTIME}`]).toEqual([`pty:${RUNTIME}`])
    expect(s.activeWorktreeId).toBe(RUNTIME)
    expect(s.activeTabId).toBe(`tab:${RUNTIME}`)
    expect(ptyKill).not.toHaveBeenCalled()
  })
})

const ENV_ID = 'env-1'
const runtimeRepo: Repo = {
  ...keptRepo,
  id: 'repo-r',
  path: '/srv/r',
  addedAt: 3,
  executionHostId: `runtime:${ENV_ID}`
}
const RUNTIME_OWNED = 'repo-r::/srv/r/wt'
const SSH_VIA_RUNTIME = 'repo-r::/home/dev/r/wt'
const LOCAL_GUARD = 'repo-kept::/kept/wt'

const runtimeCall = vi.fn()

describe('runtime fetchRepos dropping a repo that runtime removed', () => {
  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    runtimeCall.mockReset()
    runtimeCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return compatible
      }
      const result =
        args.method === 'repo.list'
          ? { repos: [] }
          : args.method === 'project.list'
            ? { projects: [] }
            : args.method === 'projectHostSetup.list'
              ? { setups: [] }
              : {}
      return { id: `rpc-${args.method}`, ok: true, result, _meta: { runtimeId: 'runtime-e' } }
    })
    vi.stubGlobal('window', {
      api: {
        repos: { list: reposList },
        projects: {
          list: vi.fn().mockResolvedValue([]),
          listHostSetups: vi.fn().mockResolvedValue([])
        },
        pty: { kill: ptyKill },
        runtimeEnvironments: {
          call: runtimeCall,
          list: vi.fn().mockResolvedValue([{ id: ENV_ID, name: 'env' }])
        }
      },
      dispatchEvent: vi.fn()
    })
  })

  it('drops the runtime-owned and SSH-through-runtime rows and their tabs', async () => {
    const store = createTestStore()
    const rows = [
      makeWorktree({
        id: RUNTIME_OWNED,
        repoId: runtimeRepo.id,
        path: '/srv/r/wt',
        hostId: `runtime:${ENV_ID}`,
        runtimeOwnerEnvironmentId: ENV_ID
      }),
      makeWorktree({
        id: SSH_VIA_RUNTIME,
        repoId: runtimeRepo.id,
        path: '/home/dev/r/wt',
        hostId: 'ssh:t1',
        runtimeOwnerEnvironmentId: ENV_ID
      })
    ]
    const guard = makeWorktree({ id: LOCAL_GUARD, repoId: keptRepo.id, path: '/kept/wt' })
    const ids = [RUNTIME_OWNED, SSH_VIA_RUNTIME, LOCAL_GUARD]
    store.setState({
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: ENV_ID },
      repos: [keptRepo, runtimeRepo],
      worktreesByRepo: { [runtimeRepo.id]: rows, [keptRepo.id]: [guard] },
      tabsByWorktree: Object.fromEntries(
        ids.map((id) => [id, [makeTab({ id: `tab:${id}`, worktreeId: id })]])
      )
    })
    const guardRows = store.getState().worktreesByRepo[keptRepo.id]
    const guardTabs = store.getState().tabsByWorktree[LOCAL_GUARD]

    await store.getState().fetchRepos({ runtimeEnvironmentId: ENV_ID })

    const s = store.getState()
    expect(runtimeCall).toHaveBeenCalledWith(expect.objectContaining({ method: 'repo.list' }))
    expect(reposList).not.toHaveBeenCalled()
    expect(s.repos.map((repo) => repo.id)).toEqual([keptRepo.id])
    expect((s.worktreesByRepo[runtimeRepo.id] ?? []).map((worktree) => worktree.id)).toEqual([])
    expect(s.tabsByWorktree).not.toHaveProperty(RUNTIME_OWNED)
    expect(s.tabsByWorktree).not.toHaveProperty(SSH_VIA_RUNTIME)
    expect(s.worktreesByRepo[keptRepo.id]).toBe(guardRows)
    expect(s.tabsByWorktree[LOCAL_GUARD]).toBe(guardTabs)
  })
})
