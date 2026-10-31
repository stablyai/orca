/** Host-change refetch and repo_not_found ghost cleanup must isolate owners (#11994). Pin both same-name distinct-ID projects and same-ID cross-host rows; removal may never affect another host. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() }
}))

const SHARED_NAME = 'Shared Project'

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/hosts/${id}`,
    displayName: SHARED_NAME,
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  } as Repo
}

const localTwin = repo('local-uuid', {
  path: '/laptop/shared',
  executionHostId: 'local'
})
const remoteATwin = repo('env-a-uuid', {
  path: '/mini/shared',
  executionHostId: 'runtime:env-a'
})
const remoteBTwin = repo('env-b-uuid', {
  path: '/server/shared',
  executionHostId: 'runtime:env-b'
})

const reposRemove = vi.fn()
const reposRemoveForHost = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn<(args: RuntimeCall) => unknown>()

type RuntimeCall = RuntimeEnvironmentCallRequest & {
  selector: string
  params?: unknown
}

/** repo.rm answers `code` for `failingSelector`'s environment and succeeds everywhere else. */
function answerRepoRm(options: { failingSelector?: string; code?: string } = {}): void {
  runtimeEnvironmentCall.mockImplementation((args: RuntimeCall) => {
    if (args.method === 'repo.rm' && args.selector === options.failingSelector) {
      return {
        id: 'rpc-repo-rm',
        ok: false,
        error: {
          code: options.code ?? 'repo_not_found',
          message: options.code ?? 'repo_not_found'
        },
        _meta: { runtimeId: `runtime-${args.selector}` }
      }
    }
    return {
      id: 'rpc',
      ok: true,
      result: {},
      _meta: { runtimeId: `runtime-${args.selector}` }
    }
  })
}

/** repo.list per environment, so a catalog refresh sees exactly what that host still has. */
function answerCatalogs(reposByEnvironment: Record<string, Repo[]>): void {
  runtimeEnvironmentCall.mockImplementation((args: RuntimeCall) => {
    const meta = { runtimeId: `runtime-${args.selector}` }
    if (args.method === 'repo.list') {
      return {
        id: 'rpc-repo-list',
        ok: true,
        result: { repos: reposByEnvironment[args.selector] ?? [] },
        _meta: meta
      }
    }
    if (args.method === 'project.list') {
      return {
        id: 'rpc-project-list',
        ok: true,
        result: { projects: [] },
        _meta: meta
      }
    }
    if (args.method === 'projectHostSetup.list') {
      return {
        id: 'rpc-setup-list',
        ok: true,
        result: { setups: [] },
        _meta: meta
      }
    }
    return { id: 'rpc', ok: true, result: {}, _meta: meta }
  })
}

function seed(repos: readonly Repo[], activeRuntimeEnvironmentId: string | null = null) {
  const store = createTestStore()
  store.setState({
    settings: { activeRuntimeEnvironmentId } as never,
    repos: [...repos]
  })
  return store
}

function repoRmCalls(): RuntimeCall[] {
  return runtimeEnvironmentTransportCall.mock.calls
    .map(([args]) => args)
    .filter((args) => args.method === 'repo.rm')
}

function remainingRepoIds(store: ReturnType<typeof seed>): string[] {
  return store.getState().repos.map((entry) => entry.id)
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  for (const mock of [
    reposRemove,
    reposRemoveForHost,
    runtimeEnvironmentCall,
    runtimeEnvironmentTransportCall
  ]) {
    mock.mockReset()
  }
  runtimeEnvironmentTransportCall.mockImplementation(
    (args) => createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  )
  answerRepoRm()
  vi.stubGlobal('window', {
    api: {
      repos: { remove: reposRemove, removeForHost: reposRemoveForHost },
      pty: { kill: vi.fn() },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall },
      ui: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
})

describe('deleting one host copy of a same-named project', () => {
  it('removes only the remote row when the same name exists locally', async () => {
    const store = seed([localTwin, remoteATwin], 'env-a')

    await store.getState().removeProject('env-a-uuid', { hostId: 'runtime:env-a' })

    expect(repoRmCalls()).toEqual([
      expect.objectContaining({
        selector: 'env-a',
        params: { repo: 'env-a-uuid' }
      })
    ])
    expect(reposRemove).not.toHaveBeenCalled()
    // Only this desktop's persisted rows for the remote host, never the local row.
    expect(reposRemoveForHost).toHaveBeenCalledWith({
      repoId: 'env-a-uuid',
      hostId: 'runtime:env-a'
    })
    expect(remainingRepoIds(store)).toEqual(['local-uuid'])
  })

  it('removes only the local row when the same name exists on a remote', async () => {
    const store = seed([localTwin, remoteATwin], 'env-a')

    await store.getState().removeProject('local-uuid', { hostId: 'local' })

    expect(reposRemoveForHost).toHaveBeenCalledWith({ repoId: 'local-uuid', hostId: 'local' })
    expect(reposRemove).not.toHaveBeenCalled()
    expect(repoRmCalls()).toEqual([])
    expect(remainingRepoIds(store)).toEqual(['env-a-uuid'])
  })

  it('removes only remote A when the same name exists on remote B', async () => {
    const store = seed([remoteATwin, remoteBTwin], 'env-b')

    await store.getState().removeProject('env-a-uuid', { hostId: 'runtime:env-a' })

    expect(repoRmCalls()).toEqual([
      expect.objectContaining({
        selector: 'env-a',
        params: { repo: 'env-a-uuid' }
      })
    ])
    expect(remainingRepoIds(store)).toEqual(['env-b-uuid'])
  })

  it('keeps remote B when remote A reports the project already gone', async () => {
    // The reporter's #11994 case with a name collision: the ghost purge is host-scoped.
    answerRepoRm({ failingSelector: 'env-a', code: 'repo_not_found' })
    const store = seed([localTwin, remoteATwin, remoteBTwin], 'env-b')

    await store.getState().removeProject('env-a-uuid', { hostId: 'runtime:env-a' })

    expect(remainingRepoIds(store)).toEqual(['local-uuid', 'env-b-uuid'])
  })
})

describe('deleting one host copy of a project whose id exists on two hosts', () => {
  const duplicateLocal = repo('dup-id', {
    path: '/laptop/dup',
    executionHostId: 'local'
  })
  const duplicateRemote = repo('dup-id', {
    path: '/mini/dup',
    executionHostId: 'runtime:env-a'
  })

  it('scopes the local removal to the local host instead of the bare id', async () => {
    const store = seed([duplicateLocal, duplicateRemote], 'env-a')

    await store.getState().removeProject('dup-id', { hostId: 'local' })

    // repos:remove is id-only and would delete every host's row in main persistence.
    expect(reposRemove).not.toHaveBeenCalled()
    expect(reposRemoveForHost).toHaveBeenCalledWith({
      repoId: 'dup-id',
      hostId: 'local'
    })
    expect(store.getState().repos.map((entry) => entry.path)).toEqual(['/mini/dup'])
  })

  it('leaves the local row when the remote copy is removed', async () => {
    const store = seed([duplicateLocal, duplicateRemote], 'env-a')

    await store.getState().removeProject('dup-id', { hostId: 'runtime:env-a' })

    expect(repoRmCalls()).toEqual([
      expect.objectContaining({
        selector: 'env-a',
        params: { repo: 'dup-id' }
      })
    ])
    expect(reposRemove).not.toHaveBeenCalled()
    expect(store.getState().repos.map((entry) => entry.path)).toEqual(['/laptop/dup'])
  })

  it('keeps the row when the owner cannot disambiguate a duplicate id', async () => {
    // selector_ambiguous is a real refusal, not missing-project proof; keep row and report failure.
    answerRepoRm({ failingSelector: 'env-a', code: 'selector_ambiguous' })
    const store = seed([duplicateLocal, duplicateRemote], 'env-a')

    await store.getState().removeProject('dup-id', { hostId: 'runtime:env-a' })

    expect(store.getState().repos.map((entry) => entry.path)).toEqual(['/laptop/dup', '/mini/dup'])
  })
})

describe('refetching one host catalog after its own delete', () => {
  it('prunes only that host rows when the name exists on other hosts', async () => {
    answerCatalogs({ 'env-a': [], 'env-b': [remoteBTwin] })
    const store = seed([localTwin, remoteATwin, remoteBTwin], 'env-a')

    await store.getState().fetchRuntimeEnvironmentRepos('env-a')

    expect(remainingRepoIds(store)).toEqual(['local-uuid', 'env-b-uuid'])
  })

  it('keeps another host row that shares the deleted repo id', async () => {
    const duplicateLocal = repo('dup-id', {
      path: '/laptop/dup',
      executionHostId: 'local'
    })
    const duplicateRemote = repo('dup-id', {
      path: '/mini/dup',
      executionHostId: 'runtime:env-a'
    })
    answerCatalogs({ 'env-a': [] })
    const store = seed([duplicateLocal, duplicateRemote], 'env-a')

    await store.getState().fetchRuntimeEnvironmentRepos('env-a')

    expect(store.getState().repos.map((entry) => entry.path)).toEqual(['/laptop/dup'])
  })
})
