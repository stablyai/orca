import { describe, expect, it } from 'vitest'
import { resolveWorktreeCreateParent } from './worktree-create-parent'
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
      worktreesByRepo: { 'repo-2': [{ id: 'parent-2', repoId: 'repo-2' }] },
      repos: [
        { id: 'repo-1', connectionId: null },
        { id: 'repo-2', connectionId: null }
      ]
    })

    expect(resolveWorktreeCreateParent(state, 'parent-2', 'repo-1')).toBeNull()
  })

  it('returns null for archived parents', () => {
    const state = makeState({
      worktreesByRepo: { 'repo-1': [{ id: 'parent-1', repoId: 'repo-1', isArchived: true }] }
    })

    expect(resolveWorktreeCreateParent(state, 'parent-1', 'repo-1')).toBeNull()
  })

  it('returns null when the parent lives on another execution host', () => {
    const state = makeState({
      worktreesByRepo: {
        'repo-1': [{ id: 'parent-1', repoId: 'repo-1', hostId: 'ssh:remote-box' }]
      }
    })

    expect(resolveWorktreeCreateParent(state, 'parent-1', 'repo-1')).toBeNull()
  })
})
