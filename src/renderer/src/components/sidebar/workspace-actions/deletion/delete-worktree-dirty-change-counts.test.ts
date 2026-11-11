import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'

import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  getDeleteWorktreeDirtyChangePreview,
  getDeleteWorktreeDirtyChangePreviews
} from './delete-worktree-dirty-change-counts'

function worktree(id: string, hostId?: Worktree['hostId']): Worktree {
  return {
    id,
    repoId: 'repo',
    path: `/${id}`,
    displayName: id,
    branch: 'refs/heads/main',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...(hostId ? { hostId } : {})
  }
}

describe('delete-worktree loaded change previews', () => {
  it('preserves an unresolved conflict when duplicate paths use different separators', () => {
    const preview = getDeleteWorktreeDirtyChangePreview([
      {
        path: 'src\\conflicted.ts',
        status: 'modified',
        area: 'unstaged',
        conflictStatus: 'unresolved',
        conflictKind: 'both_modified'
      },
      { path: 'src/conflicted.ts', status: 'added', area: 'staged' }
    ])
    expect(preview.files).toEqual([
      { path: 'src/conflicted.ts', status: 'modified', hasUnresolvedConflict: true }
    ])
  })

  it('uses qualified snapshots for colliding stamped targets without a legacy fallback', () => {
    const local = worktree('same', 'local')
    const runtime = worktree('same', 'runtime:build')
    const missing = worktree('same', 'runtime:missing')
    const input = {
      deleteTargets: [local, runtime, missing],
      gitStatusByWorktree: {
        same: [{ path: 'legacy.txt', status: 'untracked', area: 'untracked' }]
      },
      gitStatusByWorktreeIdentity: new Map<string, GitStatusEntry[]>([
        [getWorktreeHostIdentity(local), [{ path: 'local.ts', status: 'added', area: 'staged' }]],
        [
          getWorktreeHostIdentity(runtime),
          [{ path: 'runtime.ts', status: 'modified', area: 'unstaged' }]
        ]
      ]),
      repoMap: new Map()
    } satisfies Parameters<typeof getDeleteWorktreeDirtyChangePreviews>[0]
    const previews = getDeleteWorktreeDirtyChangePreviews(input)
    expect(previews.get(getWorktreeHostIdentity(local))?.files[0]?.path).toBe('local.ts')
    expect(previews.get(getWorktreeHostIdentity(runtime))?.files[0]?.path).toBe('runtime.ts')
    expect(previews.has(getWorktreeHostIdentity(missing))).toBe(false)
  })
})
