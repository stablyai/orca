import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import { createGlobalSettingsFixture } from '../../../../../../shared/global-settings-test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from '../../worktrees-slice-test-harness'
import { makeWorktree } from '../../worktrees-slice-test-fixtures'
import {
  makeDetectedResult,
  qualifyDetectedResult,
  TEST_SSH_AUTHORITY
} from '../../worktrees-detected-listing-fixtures'
import { acquireDirectSshDetectedWorktreeRefresh } from './known-ssh-worktree-fetch'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

const originalRepo: Repo = {
  id: 'repo1',
  path: '/old/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'local'
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
  mockApi.worktrees.listDetected.mockReset()
  mockApi.worktrees.listKnownForExecutionHost.mockReset()
})

describe('listings captured under a repo registration', () => {
  it.each([
    { changed: 'path', repo: { ...originalRepo, path: '/new/repo' } },
    { changed: 'addedAt', repo: { ...originalRepo, addedAt: 2 } },
    { changed: 'kind', repo: { ...originalRepo, kind: 'folder' as const } },
    {
      changed: 'publisher',
      repo: { ...originalRepo, catalogOwnerHostId: 'runtime:publisher-b' as const }
    },
    {
      changed: 'raw host',
      repo: { ...originalRepo, authoritativeExecutionHostId: 'ssh:private-b' as const }
    }
  ])(
    'separates a changed $changed registration and preserves its new instance',
    async ({ repo }) => {
      const store = createTestStore()
      const oldRow = makeWorktree({ id: 'repo1::/workspace', repoId: 'repo1', instanceId: 'old' })
      const newRow = { ...oldRow, instanceId: 'new' }
      const oldListing = deferred<DetectedWorktreeListResult>()
      store.setState({ repos: [originalRepo], worktreesByRepo: { repo1: [oldRow] } })
      mockApi.worktrees.listDetected
        .mockImplementationOnce(async (args) =>
          qualifyDetectedResult(args, await oldListing.promise)
        )
        .mockImplementationOnce(async (args) =>
          qualifyDetectedResult(args, makeDetectedResult('repo1', [newRow]))
        )

      const oldRequest = store.getState().fetchWorktrees('repo1', { executionHostId: 'local' })
      store.setState({ repos: [repo] })
      await expect(
        store.getState().fetchWorktrees('repo1', { executionHostId: 'local' })
      ).resolves.toBe(true)
      expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(2)
      const admitted = store.getState().worktreesByRepo.repo1

      oldListing.resolve(makeDetectedResult('repo1', []))
      await expect(oldRequest).resolves.toBe(false)
      expect(store.getState().worktreesByRepo.repo1).toBe(admitted)
      expect(admitted?.[0]?.instanceId).toBe('new')
      expect(store.getState().detectedWorktreesByRepo.repo1?.worktrees[0]?.instanceId).toBe('new')
      expect(mockApi.runtime.call).not.toHaveBeenCalled()
      expect(mockApi.pty.kill).not.toHaveBeenCalled()
    }
  )

  it('checks registration again after admission before dispatching terminal teardown', async () => {
    const store = createTestStore()
    const row = makeWorktree({ id: 'repo1::/old/workspace', repoId: 'repo1' })
    store.setState({ repos: [originalRepo], worktreesByRepo: { repo1: [row] } })
    mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
      qualifyDetectedResult(args, makeDetectedResult('repo1', []))
    )
    const unsubscribe = store.subscribe((state) => {
      if (state.repos[0] === originalRepo && state.worktreesByRepo.repo1?.length === 0) {
        store.setState({ repos: [{ ...originalRepo, addedAt: 2 }] })
      }
    })

    await store.getState().fetchWorktrees('repo1', { executionHostId: 'local' })
    unsubscribe()
    expect(mockApi.runtime.call).not.toHaveBeenCalled()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it('separates runtime publisher replacement requests and refuses the old completion', async () => {
    const store = createTestStore()
    const repo = { ...originalRepo, executionHostId: 'runtime:env-remote' as const }
    const oldListing = deferred<DetectedWorktreeListResult>()
    const newRow = makeWorktree({ id: 'repo1::/workspace', repoId: 'repo1', instanceId: 'new' })
    store.setState({
      repos: [repo],
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'env-remote' })
    })
    runtimeEnvironmentCall
      .mockImplementationOnce(async () => ({
        id: 'old',
        ok: true,
        result: await oldListing.promise
      }))
      .mockImplementationOnce(() => ({
        id: 'new',
        ok: true,
        result: makeDetectedResult(repo.id, [newRow])
      }))
    const options = {
      executionHostId: repo.executionHostId,
      presentationOnly: true,
      suppressRemoteLineageRefresh: true
    }
    const oldRequest = store.getState().fetchWorktrees(repo.id, options)
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
    store.setState({ repos: [{ ...repo, path: '/new/repo', addedAt: 2 }] })
    await expect(store.getState().fetchWorktrees(repo.id, options)).resolves.toBe(true)
    const admitted = store.getState().worktreesByRepo.repo1
    oldListing.resolve(makeDetectedResult(repo.id, []))

    await expect(oldRequest).resolves.toBe(false)
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
    expect(store.getState().worktreesByRepo.repo1).toBe(admitted)
    expect(admitted?.[0]?.instanceId).toBe('new')
    expect(mockApi.runtime.call).not.toHaveBeenCalled()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it.each(['detected', 'all-initial', 'all-hydrated'] as const)(
    'refuses stale %s listings without terminal reconciliation',
    async (entrypoint) => {
      const store = createTestStore()
      const row = makeWorktree({ id: 'repo1::/workspace', repoId: 'repo1' })
      const listing = deferred<DetectedWorktreeListResult>()
      store.setState({
        repos: [originalRepo],
        worktreesByRepo: { repo1: [row] },
        hasHydratedWorktreePurge: entrypoint === 'all-hydrated'
      })
      mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
        qualifyDetectedResult(args, await listing.promise)
      )
      const request =
        entrypoint === 'detected'
          ? store.getState().fetchDetectedWorktrees('repo1')
          : store.getState().fetchAllWorktrees()
      const replacement = { ...row, instanceId: 'replacement' }
      store.setState({
        repos: [{ ...originalRepo, addedAt: 2 }],
        worktreesByRepo: { repo1: [replacement] }
      })
      listing.resolve(makeDetectedResult('repo1', []))
      await request
      expect(store.getState().worktreesByRepo.repo1).toEqual([replacement])
      expect(store.getState().detectedWorktreesByRepo.repo1).toBeUndefined()
      expect(mockApi.runtime.call).not.toHaveBeenCalled()
      expect(mockApi.pty.kill).not.toHaveBeenCalled()
    }
  )

  it('does not let a direct SSH lease merge after the same registration is removed and re-added', async () => {
    const store = createTestStore()
    const repo = { ...originalRepo, executionHostId: 'ssh:ssh-1' as const }
    const listing = deferred<DetectedWorktreeListResult>()
    store.setState({ repos: [repo] })
    mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
      qualifyDetectedResult(args, await listing.promise)
    )
    const refresh = acquireDirectSshDetectedWorktreeRefresh(store, {
      repoId: repo.id,
      executionHostId: 'ssh:ssh-1',
      authority: TEST_SSH_AUTHORITY
    })
    store.setState({ repos: [] })
    store.setState({ repos: [{ ...repo, addedAt: 2 }] })
    listing.resolve(makeDetectedResult(repo.id, []))
    expect(refresh.merge(await refresh.result).status).toBe('stale')
    expect(mockApi.runtime.call).not.toHaveBeenCalled()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it('fences disconnected SSH fallback and separates replacement requests', async () => {
    const store = createTestStore()
    const repo = { ...originalRepo, executionHostId: 'ssh:ssh-1' as const }
    const oldListing = deferred<DetectedWorktreeListResult>()
    const newRow = makeWorktree({
      id: 'repo1::/new/workspace',
      repoId: 'repo1',
      hostId: 'ssh:ssh-1'
    })
    store.setState({ repos: [repo], sshConnectionStates: new Map() })
    mockApi.worktrees.listKnownForExecutionHost
      .mockImplementationOnce(async (args) => ({
        status: 'complete',
        ...args,
        result: await oldListing.promise
      }))
      .mockImplementationOnce(async (args) => ({
        status: 'complete',
        ...args,
        result: makeDetectedResult(repo.id, [newRow], { authoritative: false })
      }))
    const oldRequest = store.getState().fetchWorktrees(repo.id, { executionHostId: 'ssh:ssh-1' })
    store.setState({ repos: [{ ...repo, path: '/new/repo', addedAt: 2 }] })
    await store.getState().fetchWorktrees(repo.id, { executionHostId: 'ssh:ssh-1' })
    oldListing.resolve(
      makeDetectedResult(
        repo.id,
        [makeWorktree({ id: 'repo1::/old/workspace', repoId: 'repo1' })],
        {
          authoritative: false
        }
      )
    )
    await oldRequest
    expect(mockApi.worktrees.listKnownForExecutionHost).toHaveBeenCalledTimes(2)
    expect(store.getState().worktreesByRepo.repo1?.map((row) => row.id)).toEqual([newRow.id])
    expect(mockApi.runtime.call).not.toHaveBeenCalled()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it('coalesces the same registration while presentation-only refreshes never stop terminals', async () => {
    const store = createTestStore()
    const row = makeWorktree({ id: 'repo1::/old/workspace', repoId: 'repo1' })
    const listing = deferred<DetectedWorktreeListResult>()
    store.setState({ repos: [originalRepo], worktreesByRepo: { repo1: [row] } })
    mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
      qualifyDetectedResult(args, await listing.promise)
    )
    const options = { executionHostId: 'local' as const, presentationOnly: true }
    const requests = [store.getState().fetchWorktrees('repo1', options)]
    store.setState({ repos: [{ ...originalRepo, kind: 'git' }] })
    requests.push(
      ...Array.from({ length: 2 }, () => store.getState().fetchWorktrees('repo1', options))
    )
    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(1)
    listing.resolve(makeDetectedResult('repo1', []))
    await expect(Promise.all(requests)).resolves.toEqual([true, true, true])
    expect(store.getState().worktreesByRepo.repo1).toEqual([])
    expect(mockApi.runtime.call).not.toHaveBeenCalled()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it('preserves duplicate registration counts while sharing value-equal catalog replacements', async () => {
    const store = createTestStore()
    const listing = deferred<DetectedWorktreeListResult>()
    const nextRow = makeWorktree({ id: 'repo1::/current', repoId: 'repo1' })
    store.setState({ repos: [originalRepo, { ...originalRepo }] })
    mockApi.worktrees.listDetected
      .mockImplementationOnce(async (args) => qualifyDetectedResult(args, await listing.promise))
      .mockImplementationOnce(async (args) =>
        qualifyDetectedResult(args, makeDetectedResult('repo1', [nextRow]))
      )
    const options = { executionHostId: 'local' as const, presentationOnly: true }
    const original = store.getState().fetchWorktrees('repo1', options)
    store.setState({ repos: [{ ...originalRepo }, { ...originalRepo }] })
    const equalReplacement = store.getState().fetchWorktrees('repo1', options)
    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(1)
    store.setState({ repos: [{ ...originalRepo }] })
    await expect(store.getState().fetchWorktrees('repo1', options)).resolves.toBe(true)
    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(2)
    const admitted = store.getState().worktreesByRepo.repo1
    listing.resolve(makeDetectedResult('repo1', []))
    await expect(Promise.all([original, equalReplacement])).resolves.toEqual([false, false])
    expect(store.getState().worktreesByRepo.repo1).toBe(admitted)
    expect(admitted).toEqual([nextRow])
    expect(mockApi.runtime.call).not.toHaveBeenCalled()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })
})
