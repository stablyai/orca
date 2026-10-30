import { describe, expect, it } from 'vitest'
import { applyWorktreeUpdates } from './worktree-meta-update-application'

describe('applyWorktreeUpdates display-name provenance', () => {
  it('returns to the current branch immediately when a label is cleared', () => {
    const worktree = {
      id: 'repo-1::/workspace/feature',
      repoId: 'repo-1',
      path: '/workspace/feature',
      branch: 'refs/heads/main',
      displayName: 'Agent workspace'
    }

    const next = applyWorktreeUpdates({ 'repo-1': [worktree as never] }, worktree.id, {
      displayName: '',
      displayNameIsPinned: false
    })

    expect(next['repo-1']?.[0]).toMatchObject({
      displayName: 'main',
      displayNameMode: 'automatic'
    })
  })

  it('keeps text until the host resolves a detached fallback', () => {
    const worktree = {
      id: 'repo-1::/workspace/feature',
      repoId: 'repo-1',
      path: '/workspace/feature',
      branch: '',
      displayName: 'Agent workspace'
    }

    const next = applyWorktreeUpdates({ 'repo-1': [worktree as never] }, worktree.id, {
      displayName: '',
      displayNameIsPinned: false
    })

    expect(next['repo-1']?.[0]).toMatchObject({
      displayName: 'Agent workspace',
      displayNameMode: 'automatic'
    })
  })
})
