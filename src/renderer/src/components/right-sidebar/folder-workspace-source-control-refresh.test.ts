// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'
import {
  getFolderSourceControlRefreshCandidates,
  invalidateFolderSourceControlRefreshGeneration,
  runLimitedFolderSourceControlRefreshes,
  type FolderSourceControlRefreshCandidate
} from './folder-workspace-source-control-refresh'

const refreshMocks = vi.hoisted(() => ({
  getConnectionId: vi.fn(),
  getRightSidebarWorktreeRuntimeSettings: vi.fn(() => ({ activeRuntimeEnvironmentId: null })),
  isWebRuntimeSessionActive: vi.fn(() => true),
  refreshGitStatusForWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: refreshMocks.getConnectionId
}))

vi.mock('./file-explorer-runtime-owner', () => ({
  getRightSidebarWorktreeRuntimeSettings: refreshMocks.getRightSidebarWorktreeRuntimeSettings
}))

vi.mock('./git-status-refresh', () => ({
  refreshGitStatusForWorktree: refreshMocks.refreshGitStatusForWorktree
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: refreshMocks.isWebRuntimeSessionActive
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#fff',
    addedAt: 1,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    path: `/worktrees/${overrides.id}`,
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    repoId: 'repo-1',
    displayName: overrides.id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeCandidate(
  overrides: Partial<FolderSourceControlRefreshCandidate> = {}
): FolderSourceControlRefreshCandidate {
  return {
    worktree: makeWorktree({ id: 'repo-1::/child' }),
    repo: makeRepo(),
    expanded: true,
    manual: false,
    ...overrides
  }
}

function makeDeps() {
  return {
    setGitStatus: vi.fn(),
    updateWorktreeGitIdentity: vi.fn(),
    setUpstreamStatus: vi.fn(),
    fetchUpstreamStatus: vi.fn()
  }
}

describe('folder workspace Source Control refresh scheduling', () => {
  beforeEach(() => {
    refreshMocks.getConnectionId.mockReset()
    refreshMocks.getRightSidebarWorktreeRuntimeSettings.mockReset()
    refreshMocks.getRightSidebarWorktreeRuntimeSettings.mockReturnValue({
      activeRuntimeEnvironmentId: null
    })
    refreshMocks.isWebRuntimeSessionActive.mockReset()
    refreshMocks.isWebRuntimeSessionActive.mockReturnValue(true)
    refreshMocks.refreshGitStatusForWorktree.mockReset()
    refreshMocks.refreshGitStatusForWorktree.mockResolvedValue(undefined)
  })

  it('deduplicates a child worktree across overlapping refresh batches', async () => {
    let resolveRefresh: (() => void) | undefined
    refreshMocks.refreshGitStatusForWorktree.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve
        })
    )
    const inFlightWorktreeIds = new Map<string, number>()
    const candidate = makeCandidate()

    const firstRun = runLimitedFolderSourceControlRefreshes({
      candidates: [candidate],
      deps: makeDeps(),
      sshConnectionStates: new Map(),
      inFlightWorktreeIds
    })
    await Promise.resolve()

    await runLimitedFolderSourceControlRefreshes({
      candidates: [candidate],
      deps: makeDeps(),
      sshConnectionStates: new Map(),
      inFlightWorktreeIds
    })

    expect(refreshMocks.refreshGitStatusForWorktree).toHaveBeenCalledTimes(1)
    const finishRefresh = resolveRefresh
    if (!finishRefresh) {
      throw new Error('Expected refresh promise to be pending')
    }
    finishRefresh()
    await firstRun
    expect(inFlightWorktreeIds.has(candidate.worktree.id)).toBe(false)
  })

  it('deduplicates queued children across overlapping refresh batches', async () => {
    const pendingRefreshResolves: (() => void)[] = []
    refreshMocks.refreshGitStatusForWorktree.mockImplementation(() => {
      if (pendingRefreshResolves.length >= 3) {
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        pendingRefreshResolves.push(resolve)
      })
    })
    const inFlightWorktreeIds = new Map<string, number>()
    const candidates = ['one', 'two', 'three', 'four'].map((name) =>
      makeCandidate({ worktree: makeWorktree({ id: `repo-1::/${name}`, displayName: name }) })
    )

    const firstRun = runLimitedFolderSourceControlRefreshes({
      candidates,
      deps: makeDeps(),
      sshConnectionStates: new Map(),
      inFlightWorktreeIds
    })
    await Promise.resolve()

    await runLimitedFolderSourceControlRefreshes({
      candidates: [candidates[3]],
      deps: makeDeps(),
      sshConnectionStates: new Map(),
      inFlightWorktreeIds
    })

    expect(refreshMocks.refreshGitStatusForWorktree).toHaveBeenCalledTimes(3)
    if (pendingRefreshResolves.length !== 3) {
      throw new Error('Expected three refresh promises to be pending')
    }
    pendingRefreshResolves.forEach((resolve) => resolve())
    await firstRun
    expect(inFlightWorktreeIds.size).toBe(0)
  })

  it('does not let an older refresh clear a newer reservation', async () => {
    const pendingRefreshResolves: (() => void)[] = []
    refreshMocks.refreshGitStatusForWorktree.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pendingRefreshResolves.push(resolve)
        })
    )
    const inFlightWorktreeIds = new Map<string, number>()
    const refreshGenerationByWorktree = new Map<string, number>()
    const candidate = makeCandidate()

    const firstRun = runLimitedFolderSourceControlRefreshes({
      candidates: [candidate],
      deps: makeDeps(),
      sshConnectionStates: new Map(),
      inFlightWorktreeIds,
      refreshGenerationByWorktree
    })
    await Promise.resolve()
    invalidateFolderSourceControlRefreshGeneration(refreshGenerationByWorktree, [
      candidate.worktree.id
    ])
    inFlightWorktreeIds.delete(candidate.worktree.id)

    const secondRun = runLimitedFolderSourceControlRefreshes({
      candidates: [candidate],
      deps: makeDeps(),
      sshConnectionStates: new Map(),
      inFlightWorktreeIds,
      refreshGenerationByWorktree
    })
    await Promise.resolve()
    expect(pendingRefreshResolves).toHaveLength(2)
    expect(inFlightWorktreeIds.has(candidate.worktree.id)).toBe(true)

    pendingRefreshResolves[0]()
    await firstRun

    expect(inFlightWorktreeIds.has(candidate.worktree.id)).toBe(true)
    pendingRefreshResolves[1]()
    await secondRun
    expect(inFlightWorktreeIds.has(candidate.worktree.id)).toBe(false)
  })

  it('ignores queued refresh side effects after cleanup invalidates the batch', async () => {
    const pendingRefreshResolves: (() => void)[] = []
    let queuedRefreshArgs: { deps: ReturnType<typeof makeDeps> } | undefined
    refreshMocks.refreshGitStatusForWorktree.mockImplementation(
      (args: { deps: ReturnType<typeof makeDeps> }) => {
        if (pendingRefreshResolves.length < 3) {
          return new Promise<void>((resolve) => {
            pendingRefreshResolves.push(resolve)
          })
        }
        queuedRefreshArgs = args
        return Promise.resolve()
      }
    )
    const inFlightWorktreeIds = new Map<string, number>()
    const refreshGenerationByWorktree = new Map<string, number>()
    const deps = makeDeps()
    const candidates = ['one', 'two', 'three', 'four'].map((name) =>
      makeCandidate({ worktree: makeWorktree({ id: `repo-1::/${name}`, displayName: name }) })
    )

    const run = runLimitedFolderSourceControlRefreshes({
      candidates,
      deps,
      sshConnectionStates: new Map(),
      inFlightWorktreeIds,
      refreshGenerationByWorktree,
      concurrency: 3
    })
    await Promise.resolve()
    invalidateFolderSourceControlRefreshGeneration(
      refreshGenerationByWorktree,
      candidates.map((candidate) => candidate.worktree.id)
    )
    for (const candidate of candidates) {
      inFlightWorktreeIds.delete(candidate.worktree.id)
    }

    pendingRefreshResolves[0]()
    await Promise.resolve()
    queuedRefreshArgs?.deps.setGitStatus(candidates[3].worktree.id, { entries: [] } as never)
    expect(deps.setGitStatus).not.toHaveBeenCalled()

    pendingRefreshResolves.slice(1).forEach((resolve) => resolve())
    await run
  })

  it('allows retry after timeout while ignoring late older refresh side effects', async () => {
    let firstRefreshArgs: { deps: ReturnType<typeof makeDeps> } | undefined
    let firstRefresh = true
    refreshMocks.refreshGitStatusForWorktree.mockImplementation(
      (args: { deps: ReturnType<typeof makeDeps> }) => {
        if (firstRefresh) {
          firstRefresh = false
          firstRefreshArgs = args
          return new Promise<void>(() => undefined)
        }
        return Promise.resolve()
      }
    )
    const inFlightWorktreeIds = new Map<string, number>()
    const refreshGenerationByWorktree = new Map<string, number>()
    const candidate = makeCandidate()
    const deps = makeDeps()

    await runLimitedFolderSourceControlRefreshes({
      candidates: [candidate],
      deps,
      sshConnectionStates: new Map(),
      inFlightWorktreeIds,
      refreshGenerationByWorktree,
      timeoutMs: 1
    })

    expect(inFlightWorktreeIds.has(candidate.worktree.id)).toBe(false)
    firstRefreshArgs?.deps.setGitStatus(candidate.worktree.id, { entries: [] } as never)
    expect(deps.setGitStatus).not.toHaveBeenCalled()

    await runLimitedFolderSourceControlRefreshes({
      candidates: [candidate],
      deps,
      sshConnectionStates: new Map(),
      inFlightWorktreeIds,
      refreshGenerationByWorktree
    })

    expect(refreshMocks.refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)
    firstRefreshArgs?.deps.setGitStatus(candidate.worktree.id, { entries: [] } as never)
    expect(deps.setGitStatus).not.toHaveBeenCalled()
  })

  it('skips inactive runtime-owned repos without consuming a git refresh', async () => {
    refreshMocks.isWebRuntimeSessionActive.mockReturnValue(false)
    const outcomes = new Map<string, unknown>()
    const candidate = makeCandidate({
      repo: makeRepo({ executionHostId: 'runtime:owner-env' })
    })

    await runLimitedFolderSourceControlRefreshes({
      candidates: [candidate],
      deps: makeDeps(),
      sshConnectionStates: new Map(),
      onOutcome: (worktreeId, outcome) => outcomes.set(worktreeId, outcome)
    })

    expect(refreshMocks.isWebRuntimeSessionActive).toHaveBeenCalledWith('owner-env')
    expect(refreshMocks.refreshGitStatusForWorktree).not.toHaveBeenCalled()
    expect(outcomes.get(candidate.worktree.id)).toEqual({
      kind: 'unavailable',
      reason: 'runtime'
    })
  })

  it('skips disconnected SSH repos declared through executionHostId', async () => {
    const outcomes = new Map<string, unknown>()
    const candidate = makeCandidate({
      repo: makeRepo({ connectionId: null, executionHostId: 'ssh:ssh-target' })
    })

    await runLimitedFolderSourceControlRefreshes({
      candidates: [candidate],
      deps: makeDeps(),
      sshConnectionStates: new Map([['ssh-target', { status: 'disconnected' }]]),
      onOutcome: (worktreeId, outcome) => outcomes.set(worktreeId, outcome)
    })

    expect(refreshMocks.refreshGitStatusForWorktree).not.toHaveBeenCalled()
    expect(outcomes.get(candidate.worktree.id)).toEqual({
      kind: 'unavailable',
      reason: 'ssh'
    })
  })

  it('skips disconnected SSH worktrees declared through hostId', async () => {
    const outcomes = new Map<string, unknown>()
    const candidate = makeCandidate({
      repo: makeRepo({ connectionId: null, executionHostId: 'local' }),
      worktree: makeWorktree({ id: 'repo-1::/ssh-child', hostId: 'ssh:ssh-target' })
    })

    await runLimitedFolderSourceControlRefreshes({
      candidates: [candidate],
      deps: makeDeps(),
      sshConnectionStates: new Map([['ssh-target', { status: 'disconnected' }]]),
      onOutcome: (worktreeId, outcome) => outcomes.set(worktreeId, outcome)
    })

    expect(refreshMocks.refreshGitStatusForWorktree).not.toHaveBeenCalled()
    expect(outcomes.get(candidate.worktree.id)).toEqual({
      kind: 'unavailable',
      reason: 'ssh'
    })
  })

  it('does not inherit repo SSH connection when a worktree host is local', async () => {
    const candidate = makeCandidate({
      repo: makeRepo({ connectionId: 'ssh-target', executionHostId: 'ssh:ssh-target' }),
      worktree: makeWorktree({ id: 'repo-1::/local-child', hostId: 'local' })
    })

    await runLimitedFolderSourceControlRefreshes({
      candidates: [candidate],
      deps: makeDeps(),
      sshConnectionStates: new Map([['ssh-target', { status: 'disconnected' }]])
    })

    expect(refreshMocks.refreshGitStatusForWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: undefined })
    )
  })

  it('selects the repo matching a worktree host when repo ids are duplicated', () => {
    const worktree = makeWorktree({ id: 'repo-1::/ssh-child', hostId: 'ssh:ssh-target' })
    const candidates = getFolderSourceControlRefreshCandidates({
      worktrees: [worktree],
      repos: [
        makeRepo({ connectionId: null, executionHostId: 'local', displayName: 'Local Repo' }),
        makeRepo({
          connectionId: 'ssh-target',
          executionHostId: 'ssh:ssh-target',
          displayName: 'SSH Repo'
        })
      ],
      expandedWorktreeIds: new Set([worktree.id])
    })

    expect(candidates[0]?.repo.displayName).toBe('SSH Repo')
  })
})
