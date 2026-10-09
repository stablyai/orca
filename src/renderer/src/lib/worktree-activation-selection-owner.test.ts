import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'
import { createWorktreeIdentity } from '../../../shared/worktree/identity'
import type { WorktreeSelectionOwner } from '../../../shared/worktree-selection-owner'
import { activateAndRevealWorktree } from './worktree-activation'
import { repoWithFetchedOwner } from '../store/repos/owner-routing'
import { withRepoHostOwnership } from '../store/slices/worktrees/listing/worktree-host-ownership'
import { worktreeSelectionOwnerForRow } from './worktree-selection-owner'
import { resolveWorktreeOperationRouteResult } from './worktree-operation-route'

vi.mock('./worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn(() => null)
}))
vi.mock('./resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: vi.fn()
}))
vi.mock('./web-runtime-worktree-terminal-after-wake', () => ({
  ensureWebRuntimeWorktreeTerminalAfterWake: vi.fn()
}))

const initial = useAppStore.getState()
afterEach(() => useAppStore.setState(initial, true))

describe('checked activation owner admission', () => {
  it('carries the producer owner through real activation and an implicit reselect', () => {
    const id = 'repo-1::/same/path'
    const repos = ['publisher-a', 'publisher-b'].flatMap((publisher) =>
      ['private-a', 'private-b'].map((privateHost) =>
        repoWithFetchedOwner(
          {
            id: 'repo-1',
            path: '/same/path',
            displayName: 'repo',
            badgeColor: 'blue',
            addedAt: 1,
            executionHostId: `ssh:${privateHost}`,
            connectionId: privateHost
          },
          { kind: 'environment', environmentId: publisher }
        )
      )
    )
    const rows = ['publisher-a', 'publisher-b'].flatMap((publisher) =>
      ['private-a', 'private-b'].map((privateHost) => {
        const instanceId = `${publisher}-${privateHost}`
        return withRepoHostOwnership(
          makeWorktree({
            id,
            repoId: 'repo-1',
            path: '/same/path',
            hostId: `ssh:${privateHost}`,
            instanceId,
            identity: createWorktreeIdentity({
              worktreeId: id,
              executionHostId: `ssh:${privateHost}`,
              instanceId
            })
          }),
          `runtime:${publisher}`
        )
      })
    )
    const row = rows[3]!
    const owner = worktreeSelectionOwnerForRow(row, repos)
    expect(owner).not.toBeNull()
    if (!owner) {
      throw new Error('Producer owner missing')
    }
    useAppStore.setState({
      repos,
      worktreesByRepo: { 'repo-1': rows },
      detectedWorktreesByRepo: {},
      activeWorktreeId: null,
      activeRepoId: null,
      activeWorkspaceOwner: null,
      activeView: 'settings',
      refreshGitHubForWorktreeIfStale: vi.fn()
    })
    expect(
      activateAndRevealWorktree(id, {
        owner: { ...owner, instanceId: undefined },
        providesInitialSurface: true,
        notifyHostRuntime: false
      })
    ).toEqual({
      primaryTabId: null
    })
    expect(useAppStore.getState().activeRepoId).toBe('repo-1')
    expect(useAppStore.getState().activeView).toBe('terminal')
    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('ssh:private-b')
    const visited = vi.spyOn(useAppStore.getState(), 'markWorktreeVisited')
    expect(
      activateAndRevealWorktree(id, {
        owner: { ...owner, instanceId: undefined },
        providesInitialSurface: true,
        notifyHostRuntime: false
      })
    ).toEqual({ primaryTabId: null })
    expect(visited).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeWorkspaceOwner).toEqual(owner)
    expect(resolveWorktreeOperationRouteResult(useAppStore.getState(), id)).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'ssh:private-b', runtimeEnvironmentId: 'publisher-b' }
    })
    expect(
      activateAndRevealWorktree(id, { providesInitialSurface: true, notifyHostRuntime: false })
    ).toEqual({
      primaryTabId: null
    })
    expect(useAppStore.getState().activeWorkspaceOwner).toEqual(owner)
    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('ssh:private-b')
  })

  it('refuses an instance retired after lookup before any activation effects', () => {
    const id = 'repo-1::/same/path'
    const owner: WorktreeSelectionOwner = {
      worktreeId: id,
      publisherHostId: 'runtime:publisher',
      executionHostId: 'ssh:private',
      instanceId: 'old'
    }
    const row = makeWorktree({
      id,
      repoId: 'repo-1',
      hostId: owner.executionHostId,
      runtimeOwnerEnvironmentId: 'publisher',
      instanceId: 'old',
      identity: createWorktreeIdentity({ ...owner, instanceId: 'old' })
    })
    const replacement = {
      ...row,
      instanceId: 'new',
      identity: createWorktreeIdentity({ ...owner, instanceId: 'new' })
    }
    const setActiveRepo = vi.fn()
    const setActiveView = vi.fn()
    const markWorktreeVisited = vi.fn()
    const recordWorktreeVisit = vi.fn()
    const revealWorktreeInSidebar = vi.fn()
    const refreshGitHubForWorktreeIfStale = vi.fn()
    useAppStore.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/same/path',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          executionHostId: 'runtime:publisher',
          catalogOwnerHostId: 'runtime:publisher',
          authoritativeExecutionHostId: 'ssh:private'
        }
      ],
      worktreesByRepo: { 'repo-1': [row] },
      detectedWorktreesByRepo: {},
      activeWorktreeId: null,
      activeRepoId: null,
      activeWorkspaceOwner: null,
      activeView: 'settings',
      setActiveRepo,
      setActiveView,
      markWorktreeVisited,
      recordWorktreeVisit,
      revealWorktreeInSidebar,
      refreshGitHubForWorktreeIfStale,
      getKnownWorktreeById: (worktreeId, hostId, capturedOwner) => {
        const found = initial.getKnownWorktreeById(worktreeId, hostId, capturedOwner)
        useAppStore.setState({ worktreesByRepo: { 'repo-1': [replacement] } })
        return found
      }
    })
    expect(activateAndRevealWorktree(id, { owner })).toBe(false)
    expect(useAppStore.getState().activeWorktreeId).toBeNull()
    for (const effect of [
      setActiveRepo,
      setActiveView,
      markWorktreeVisited,
      recordWorktreeVisit,
      revealWorktreeInSidebar,
      refreshGitHubForWorktreeIfStale
    ]) {
      expect(effect).not.toHaveBeenCalled()
    }
  })
})
