import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorktreeIdentity } from '../../../shared/worktree/identity'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeSelectionOwner } from '../../../shared/worktree-selection-owner'
import { makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'
import { createTestStore } from '../store/slices/worktrees-slice-test-harness'
import { findKnownWorktreeById } from '../store/slices/worktrees/listing/detected-worktree-meta'
import { selectKnownWorktreeById, selectRepoByIdForActiveWorkspace } from '../store/selectors'
import { resolveWorktreeOperationRouteResult } from './worktree-operation-route'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'
import { makeDetectedResult } from '../store/slices/worktrees-detected-listing-fixtures'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

const id = 'repo1::/same/path'
const repos: Repo[] = []
const rows = ['publisher-a', 'publisher-b'].flatMap((publisher) =>
  (['ssh:private-a', 'ssh:private-b'] as const).map((rawHost) => {
    const instanceId = `${publisher}-${rawHost}`
    repos.push({
      id: 'repo1',
      path: '/same/path',
      displayName: publisher,
      badgeColor: '#000',
      addedAt: 1,
      executionHostId: `runtime:${publisher}`,
      catalogOwnerHostId: `runtime:${publisher}`,
      authoritativeExecutionHostId: rawHost
    })
    return makeWorktree({
      id,
      repoId: 'repo1',
      path: '/same/path',
      hostId: rawHost,
      runtimeOwnerEnvironmentId: publisher,
      instanceId,
      identity: createWorktreeIdentity({ worktreeId: id, executionHostId: rawHost, instanceId })
    })
  })
)
const target = rows[3]!
const owner: WorktreeSelectionOwner = {
  worktreeId: id,
  publisherHostId: 'runtime:publisher-b',
  executionHostId: 'ssh:private-b',
  instanceId: target.instanceId
}
let store: ReturnType<typeof createTestStore>
beforeEach(() => {
  store = createTestStore()
  store.setState({
    repos,
    worktreesByRepo: { repo1: rows },
    detectedWorktreesByRepo: {},
    activeRepoId: 'repo1',
    activeWorkspaceExecutionHostId: null
  })
})

describe('checked selected worktree owner', () => {
  it('selects one publisher/raw host and keeps that owner in active lookups and routes', () => {
    expect(findKnownWorktreeById(store.getState(), id, undefined, owner)).toBe(target)
    expect(store.getState().setActiveWorktree(id, owner.executionHostId, { owner })).toBe(true)
    expect(store.getState().getKnownWorktreeById(id)).toBe(target)
    expect(selectKnownWorktreeById(store.getState(), id)).toBe(target)
    expect(selectRepoByIdForActiveWorkspace(store.getState(), 'repo1')).toBe(repos[3])
    expect(resolveWorktreeOperationRouteResult(store.getState(), id)).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'ssh:private-b', runtimeEnvironmentId: 'publisher-b' }
    })
    expect(getResolvedExecutionHostIdForWorktree(store.getState(), id)).toBe('ssh:private-b')
  })

  it('refuses unqualified ambiguous lookup and activation', () => {
    expect(store.getState().getKnownWorktreeById(id)).toBeUndefined()
    expect(store.getState().setActiveWorktree(id, 'ssh:private-b')).toBe(false)
    expect(store.getState().activeWorktreeId).toBeNull()
    expect(store.getState().refreshGitHubForWorktreeIfStale).not.toHaveBeenCalled()
  })

  it('uses explicit paired provenance without scanning repositories on repeated lookup', () => {
    const currentRepos = [...repos]
    const scan = vi.spyOn(currentRepos, 'filter')
    store.setState({ repos: currentRepos })
    expect(findKnownWorktreeById(store.getState(), id, undefined, owner)).toBe(target)
    expect(findKnownWorktreeById(store.getState(), id, undefined, owner)).toBe(target)
    expect(scan).not.toHaveBeenCalled()
  })

  it('captures an available instance for a partial owner before later replacement', () => {
    expect(
      store
        .getState()
        .setActiveWorktree(id, owner.executionHostId, {
          owner: { ...owner, instanceId: undefined }
        })
    ).toBe(true)
    expect(store.getState().activeWorkspaceOwner).toEqual(owner)
    const replacement = {
      ...target,
      instanceId: 'replacement',
      identity: createWorktreeIdentity({ ...owner, instanceId: 'replacement' })
    }
    store.setState({ worktreesByRepo: { repo1: [replacement] } })
    expect(store.getState().getKnownWorktreeById(id)).toBeUndefined()
    expect(resolveWorktreeOperationRouteResult(store.getState(), id)).toEqual({ kind: 'missing' })
  })

  it('prefers the normal visible copy over the detected copy of the same occupant', () => {
    store.setState({ detectedWorktreesByRepo: { repo1: makeDetectedResult('repo1', [target]) } })
    expect(findKnownWorktreeById(store.getState(), id, undefined, owner)).toBe(target)
  })

  it('keeps implicit reselect and owner-only activation host consistent and refuses contradictory hints', () => {
    expect(store.getState().setActiveWorktree(id, undefined, { owner })).toBe(true)
    expect(store.getState().activeWorkspaceExecutionHostId).toBe(owner.executionHostId)
    expect(store.getState().setActiveWorktree(id)).toBe(true)
    expect(store.getState().activeWorkspaceExecutionHostId).toBe(owner.executionHostId)
    expect(store.getState().activeWorkspaceOwner).toEqual(owner)
    const before = store.getState()
    expect(store.getState().setActiveWorktree(id, 'ssh:private-a', { owner })).toBe(false)
    expect(store.getState()).toBe(before)
  })

  it('does not use detected copies to bypass ambiguous visible ownership', () => {
    store.setState({ detectedWorktreesByRepo: { repo1: makeDetectedResult('repo1', [target]) } })
    expect(findKnownWorktreeById(store.getState(), id)).toBeUndefined()
    expect(findKnownWorktreeById(store.getState(), id, 'ssh:private-b')).toBeUndefined()
  })

  it('refuses duplicate detected rows and contradictory immutable identity', () => {
    store.setState({
      worktreesByRepo: {},
      detectedWorktreesByRepo: { repo1: makeDetectedResult('repo1', [target, { ...target }]) }
    })
    expect(findKnownWorktreeById(store.getState(), id, undefined, owner)).toBeUndefined()
    store.setState({
      worktreesByRepo: { repo1: [{ ...target, hostId: 'ssh:private-a' }] },
      detectedWorktreesByRepo: {}
    })
    expect(findKnownWorktreeById(store.getState(), id, undefined, owner)).toBeUndefined()
  })

  it.each(['duplicate-visible', 'conflicting-instance', 'missing-instance'] as const)(
    'refuses %s proof',
    (reason) => {
      if (reason === 'duplicate-visible') {
        store.setState({ worktreesByRepo: { repo1: [target, { ...target }] } })
      }
      if (reason === 'conflicting-instance') {
        store.setState({
          detectedWorktreesByRepo: {
            repo1: makeDetectedResult('repo1', [
              {
                ...target,
                instanceId: 'other',
                identity: createWorktreeIdentity({
                  worktreeId: id,
                  executionHostId: owner.executionHostId,
                  instanceId: 'other'
                })
              }
            ])
          }
        })
      }
      if (reason === 'missing-instance') {
        store.setState({
          worktreesByRepo: { repo1: [{ ...target, instanceId: undefined, identity: undefined }] }
        })
      }
      expect(findKnownWorktreeById(store.getState(), id, undefined, owner)).toBeUndefined()
      expect(store.getState().setActiveWorktree(id, owner.executionHostId, { owner })).toBe(false)
    }
  )

  it('invalidates active repo cache when rows disappear, and resolves again when they hydrate', () => {
    store.getState().setActiveWorktree(id, owner.executionHostId, { owner })
    expect(selectRepoByIdForActiveWorkspace(store.getState(), 'repo1')).toBe(repos[3])
    store.setState({ worktreesByRepo: {} })
    expect(selectRepoByIdForActiveWorkspace(store.getState(), 'repo1')).toBeNull()
    expect(store.getState().getKnownWorktreeById(id)).toBeUndefined()
    expect(resolveWorktreeOperationRouteResult(store.getState(), id)).toEqual({ kind: 'missing' })
    expect(getResolvedExecutionHostIdForWorktree(store.getState(), id)).toBeNull()
    store.setState({ worktreesByRepo: { repo1: rows } })
    expect(selectRepoByIdForActiveWorkspace(store.getState(), 'repo1')).toBe(repos[3])
  })

  it('changes publisher at the same locator and clears proof on a legacy selection or null', () => {
    store.getState().setActiveWorktree(id, owner.executionHostId, { owner })
    const otherOwner = {
      ...owner,
      publisherHostId: 'runtime:publisher-a' as const,
      instanceId: rows[1]?.instanceId
    }
    store.getState().setActiveWorktree(id, owner.executionHostId, { owner: otherOwner })
    expect(resolveWorktreeOperationRouteResult(store.getState(), id)).toEqual({
      kind: 'resolved',
      route: { executionHostId: owner.executionHostId, runtimeEnvironmentId: 'publisher-a' }
    })
    store.setState({ worktreesByRepo: { repo1: [target] } })
    store.getState().setActiveWorktree(id, owner.executionHostId)
    expect(store.getState().activeWorkspaceOwner).toBeNull()
    store.getState().setActiveWorktree(null)
    expect(store.getState().activeWorkspaceOwner).toBeNull()
  })
})
