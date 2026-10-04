import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  getDeleteWorktreeDirtyChangeCounts,
  getDeleteWorktreeDirtyChangePreview,
  getDeleteWorktreeDirtyChangePreviews,
  orderDeleteWorktreeStatusHydrationTargets
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

describe('delete-worktree status hydration ordering', () => {
  it('orders the active target first, visible targets next, and descendants last', () => {
    const targets = [
      worktree('descendant-a'),
      worktree('visible-a'),
      worktree('active', 'ssh:builder'),
      worktree('visible-b'),
      worktree('descendant-b')
    ]

    expect(
      orderDeleteWorktreeStatusHydrationTargets({
        targets,
        visibleTargets: [targets[1], targets[3]],
        activeWorktreeId: 'active',
        activeExecutionHostId: 'ssh:builder'
      }).map((target) => target.id)
    ).toEqual(['active', 'visible-a', 'visible-b', 'descendant-a', 'descendant-b'])
  })
})

describe('delete-worktree loaded change previews', () => {
  it('lists a staged and unstaged path once while preserving the existing warning count', () => {
    const target = worktree('target')
    const entries: GitStatusEntry[] = [
      { path: 'src/a.ts', status: 'added', area: 'staged' },
      { path: 'src/a.ts', status: 'modified', area: 'unstaged' },
      { path: 'notes.md', status: 'untracked', area: 'untracked' }
    ]
    const input = {
      deleteTargets: [target],
      deleteStateByWorktreeId: {},
      gitStatusByWorktree: { target: entries },
      repoMap: new Map()
    }
    expect(getDeleteWorktreeDirtyChangeCounts(input).get('target')).toBe(3)
    expect(getDeleteWorktreeDirtyChangePreviews(input).get('target')).toEqual({
      files: [
        { path: 'src/a.ts', status: 'modified', hasUnresolvedConflict: false },
        { path: 'notes.md', status: 'untracked', hasUnresolvedConflict: false }
      ],
      remainingPathCount: 0
    })
  })

  it('retains only ten preview rows and counts remaining unique loaded paths', () => {
    const entries: GitStatusEntry[] = Array.from({ length: 1000 }, (_, index) => ({
      path: `output/${index}.txt`,
      status: 'untracked',
      area: 'untracked'
    }))
    entries.push({ path: 'output/999.txt', status: 'added', area: 'staged' })
    const preview = getDeleteWorktreeDirtyChangePreview(entries)
    expect(preview.files).toHaveLength(10)
    expect(preview.files[9]?.path).toBe('output/9.txt')
    expect(preview.remainingPathCount).toBe(990)
  })

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

  it.each([undefined, []])(
    'keeps a generic dirty warning without inventing paths: %s',
    (entries) => {
      const input = {
        deleteTargets: [worktree('target')],
        deleteStateByWorktreeId: {
          target: {
            isDeleting: false,
            error: null,
            canForceDelete: true,
            forceDeleteReason: 'dirty'
          }
        },
        gitStatusByWorktree: { target: entries },
        repoMap: new Map()
      } satisfies Parameters<typeof getDeleteWorktreeDirtyChangeCounts>[0]
      expect(getDeleteWorktreeDirtyChangeCounts(input).get('target')).toBe(0)
      expect(getDeleteWorktreeDirtyChangePreviews(input).size).toBe(0)
    }
  )

  it('skips main and folder workspaces even when their snapshot contains changes', () => {
    const folderRepo: Repo = {
      id: 'folder',
      kind: 'folder',
      path: '/project',
      displayName: 'project',
      badgeColor: '',
      addedAt: 0
    }
    const input = {
      deleteTargets: [
        { ...worktree('main'), isMainWorktree: true },
        { ...worktree('folder'), repoId: folderRepo.id }
      ],
      gitStatusByWorktree: {
        main: [{ path: 'main.txt', status: 'untracked', area: 'untracked' }],
        folder: [{ path: 'folder.txt', status: 'untracked', area: 'untracked' }]
      },
      repoMap: new Map([[folderRepo.id, folderRepo]])
    } satisfies Parameters<typeof getDeleteWorktreeDirtyChangePreviews>[0]
    expect(getDeleteWorktreeDirtyChangeCounts({ ...input, deleteStateByWorktreeId: {} }).size).toBe(
      0
    )
    expect(getDeleteWorktreeDirtyChangePreviews(input).size).toBe(0)
  })
})
