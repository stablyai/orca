import type { AppState } from '../types'
import { editSessionSource } from '../session-source-edits'
import { describe, expect, it } from 'vitest'
import { applyWorktreeUpdates as applyUpdates } from './worktree-meta-update-application'

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

function applyWorktreeUpdates(
  worktreesByRepo: AppState['worktreesByRepo'],
  ...args: Parameters<typeof applyUpdates> extends [unknown, ...infer Rest] ? Rest : never
) {
  const edit = editSessionSource({ worktreesByRepo })
  applyUpdates(edit, ...args)
  return edit.read('worktreesByRepo')
}
