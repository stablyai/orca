import { describe, expect, it } from 'vitest'
import { canCreateChildWorkspace, resolveWorktreeCreateParent } from './worktree-create-parent'
import type { AppState } from '@/store/types'

type StateFixture = Pick<AppState, 'worktreesByRepo' | 'repos'>

function makeState(args: {
  worktreesByRepo: Record<string, object[]>
  repos?: object[]
}): StateFixture {
  return {
    worktreesByRepo: args.worktreesByRepo,
    repos: args.repos ?? [{ id: 'repo-1', connectionId: null }]
  } as unknown as StateFixture
}

describe('canCreateChildWorkspace', () => {
  it('offers child creation for git-backed rows with a branch', () => {
    expect(
      canCreateChildWorkspace({
        repo: { kind: 'git' },
        branch: 'feature/api',
        isFolderWorkspace: false
      })
    ).toBe(true)
    // Legacy repos persisted without a kind are git repos.
    expect(canCreateChildWorkspace({ repo: {}, branch: 'main', isFolderWorkspace: false })).toBe(
      true
    )
  })

  it('hides child creation when there is no branch to base the child on', () => {
    expect(
      canCreateChildWorkspace({ repo: { kind: 'git' }, branch: '', isFolderWorkspace: false })
    ).toBe(false)
  })

  it('hides child creation for folder workspaces and missing projects', () => {
    expect(
      canCreateChildWorkspace({
        repo: { kind: 'folder' },
        branch: 'feature/api',
        isFolderWorkspace: false
      })
    ).toBe(false)
    expect(
      canCreateChildWorkspace({
        repo: { kind: 'git' },
        branch: 'feature/api',
        isFolderWorkspace: true
      })
    ).toBe(false)
    expect(
      canCreateChildWorkspace({ repo: null, branch: 'feature/api', isFolderWorkspace: false })
    ).toBe(false)
  })
})

describe('resolveWorktreeCreateParent', () => {
  it('resolves an eligible same-repo parent', () => {
    const state = makeState({
      worktreesByRepo: { 'repo-1': [{ id: 'parent-1', repoId: 'repo-1', branch: 'feat/api' }] }
    })

    expect(resolveWorktreeCreateParent(state, 'parent-1', 'repo-1')?.id).toBe('parent-1')
  })

  it('returns null when the parent no longer exists', () => {
    const state = makeState({ worktreesByRepo: { 'repo-1': [] } })

    expect(resolveWorktreeCreateParent(state, 'parent-1', 'repo-1')).toBeNull()
  })

  it('returns null when the create targets another repo', () => {
    const state = makeState({
      worktreesByRepo: { 'repo-2': [{ id: 'parent-2', repoId: 'repo-2', branch: 'feat/api' }] },
      repos: [
        { id: 'repo-1', connectionId: null },
        { id: 'repo-2', connectionId: null }
      ]
    })

    expect(resolveWorktreeCreateParent(state, 'parent-2', 'repo-1')).toBeNull()
  })

  it('returns null for archived parents', () => {
    const state = makeState({
      worktreesByRepo: {
        'repo-1': [{ id: 'parent-1', repoId: 'repo-1', branch: 'feat/api', isArchived: true }]
      }
    })

    expect(resolveWorktreeCreateParent(state, 'parent-1', 'repo-1')).toBeNull()
  })

  it('returns null when the parent went branchless after the composer opened', () => {
    // Why: the entry gate rejects branchless rows; the submit-time check must
    // match, or a parent detached mid-compose records base-less lineage.
    const state = makeState({
      worktreesByRepo: { 'repo-1': [{ id: 'parent-1', repoId: 'repo-1', branch: '' }] }
    })

    expect(resolveWorktreeCreateParent(state, 'parent-1', 'repo-1')).toBeNull()
  })

  it('returns null when the parent lives on another execution host', () => {
    const state = makeState({
      worktreesByRepo: {
        'repo-1': [
          { id: 'parent-1', repoId: 'repo-1', branch: 'feat/api', hostId: 'ssh:remote-box' }
        ]
      }
    })

    expect(resolveWorktreeCreateParent(state, 'parent-1', 'repo-1')).toBeNull()
  })
})
