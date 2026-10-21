import { describe, expect, it } from 'vitest'
import { makeFolderWorkspace, makeWorktree } from '@/components/worktree-jump-palette-test-fixtures'
import { readWindowPairedServerRows } from './paired-server-rows-shadow'

describe('readWindowPairedServerRows', () => {
  it("keys each listed server's rows by host, so a local row with the same bare id stays apart", () => {
    const rows = readWindowPairedServerRows(
      {
        worktreesByRepo: {
          'repo-1': [
            makeWorktree('same', 'On the server', { hostId: 'runtime:box', isPinned: true }),
            makeWorktree('same', 'Local', { hostId: 'local' }),
            makeWorktree('other', 'Unlisted server', { hostId: 'runtime:gone' })
          ]
        },
        folderWorkspaces: [makeFolderWorkspace({ executionHostId: 'runtime:box', name: 'Notes' })],
        repos: [],
        worktreeLineageById: {}
      },
      new Set(['runtime:box'])
    )
    expect(Object.fromEntries(rows)).toEqual({
      'runtime:box|same': {
        key: 'runtime:box|same',
        worktreeId: 'same',
        repoId: 'repo-1',
        kind: 'git',
        path: '/tmp/same',
        branch: 'refs/heads/main',
        displayName: 'On the server',
        isArchived: false,
        isPinned: true,
        isMainWorktree: false,
        isUnread: false,
        lineage: null,
        workspaceStatus: 'in-progress',
        sortOrder: 0,
        defaultBranch: false,
        recentAt: 0
      },
      'runtime:box|folder:folder-1': expect.objectContaining({
        kind: 'folder',
        worktreeId: 'folder:folder-1',
        displayName: 'Notes'
      })
    })
  })
})
