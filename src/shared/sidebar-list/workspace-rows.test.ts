import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../folder-workspace-types'
import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import {
  buildWorkspaceRows as buildKeyedWorkspaceRows,
  listGitWorkspaceRowKeys,
  WorkspaceRowsSnapshotSchema,
  type WorkspaceRow
} from './workspace-rows'

/** Permit literal row-key assertions. */
const buildWorkspaceRows = (
  catalog: Parameters<typeof buildKeyedWorkspaceRows>[0]
): Map<string, WorkspaceRow> => new Map(buildKeyedWorkspaceRows(catalog))

const localRepo: Repo = {
  id: 'repo-1',
  path: '/r',
  displayName: 'r',
  badgeColor: 'blue',
  addedAt: 1
}
const sshRepo: Repo = { ...localRepo, path: '/remote/r', connectionId: 'box' }

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/r/a',
    repoId: 'repo-1',
    path: '/r/a',
    head: 'abc',
    branch: 'refs/heads/a',
    isBare: false,
    isMainWorktree: false,
    displayName: 'a',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const folder: FolderWorkspace = {
  id: 'f1',
  projectGroupId: 'g1',
  name: 'Notes',
  folderPath: '/notes',
  linkedTask: null,
  comment: 'hi',
  isArchived: false,
  isUnread: true,
  isPinned: true,
  sortOrder: 0,
  lastActivityAt: 5,
  createdAt: 2,
  updatedAt: 3
}

describe('buildWorkspaceRows', () => {
  it('keys rows by host and keeps catalog, metadata and sort stamps only', () => {
    const rows = buildWorkspaceRows({
      worktrees: [
        worktree({ hostId: 'local', isPinned: true, linkedPR: 12, lastActivityAt: 99 }),
        worktree({ hostId: 'ssh:box', branch: '', head: '' })
      ],
      folderWorkspaces: [folder],
      repos: [localRepo, sshRepo],
      lineageById: {}
    })
    expect([...rows.keys()]).toEqual([
      'local|repo-1::/r/a',
      'ssh:box|repo-1::/r/a',
      'local|folder:f1'
    ])
    expect(rows.get('local|repo-1::/r/a')).toMatchObject({
      kind: 'git',
      hostId: 'local',
      isPinned: true,
      linkedPR: 12,
      defaultBranch: false
    })
    expect(rows.get('local|repo-1::/r/a')).not.toHaveProperty('lastActivityAt')
    expect(rows.get('ssh:box|repo-1::/r/a')).toMatchObject({ hostId: 'ssh:box', branch: '' })
    expect(rows.get('local|folder:f1')).toMatchObject({
      kind: 'folder',
      repoId: 'folder-workspace:g1',
      displayName: 'Notes',
      isPinned: true,
      isUnread: true,
      lineage: null
    })
  })

  it('keys a row whose metadata names no host as the window does, its owner from the repo', () => {
    const sshOnly = { ...sshRepo, id: 'repo-ssh' }
    const rows = buildWorkspaceRows({
      worktrees: [
        worktree(),
        // The window stamps a remote repo's host on every row it lists.
        worktree({ id: 'repo-ssh::/remote/b', repoId: 'repo-ssh' }),
        worktree({ id: 'repo-2::/x', repoId: 'repo-2', hostId: 'runtime:env-1' })
      ],
      folderWorkspaces: [{ ...folder, executionHostId: 'runtime:env-1' }],
      repos: [localRepo, sshOnly],
      lineageById: {}
    })
    expect([...rows.keys()]).toEqual(['|repo-1::/r/a', 'ssh:box|repo-ssh::/remote/b'])
    expect(rows.get('|repo-1::/r/a')?.hostId).toBe('local')
  })

  it('carries the stored lineage edge for the builder to validate', () => {
    const rows = buildWorkspaceRows({
      worktrees: [worktree({ hostId: 'local', instanceId: 'a-1' })],
      folderWorkspaces: [],
      repos: [localRepo],
      lineageById: {
        'repo-1::/r/a': {
          worktreeId: 'repo-1::/r/a',
          worktreeInstanceId: 'a-1',
          parentWorktreeId: 'repo-1::/r',
          parentWorktreeInstanceId: 'p-1',
          origin: 'cli',
          capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
          createdAt: 1
        }
      }
    })
    expect(rows.get('local|repo-1::/r/a')).toMatchObject({
      instanceId: 'a-1',
      lineage: {
        parentWorktreeId: 'repo-1::/r',
        worktreeInstanceId: 'a-1',
        parentWorktreeInstanceId: 'p-1'
      }
    })
  })

  it('carries the owning host’s sort stamps, on worktrees and folder workspaces', () => {
    const rows = buildWorkspaceRows({
      worktrees: [
        worktree({ hostId: 'local', lastActivityAt: 40, smartTier: 'needs-you', smartAt: 30 })
      ],
      folderWorkspaces: [{ ...folder, smartTier: 'done', smartAt: 4 }],
      repos: [localRepo],
      lineageById: {}
    })
    expect(rows.get('local|repo-1::/r/a')).toMatchObject({
      recentAt: 40,
      smartTier: 'needs-you',
      smartAt: 30
    })
    expect(rows.get('local|folder:f1')).toMatchObject({
      recentAt: 5,
      smartTier: 'done',
      smartAt: 4
    })
    // Rest has no tier, and an older host's row parses without any stamp.
    const rest = buildWorkspaceRows({
      worktrees: [worktree({ hostId: 'local' })],
      folderWorkspaces: [],
      repos: [localRepo],
      lineageById: {}
    }).get('local|repo-1::/r/a')
    expect(rest).not.toHaveProperty('smartTier')
    const { recentAt: _recentAt, ...older } = rest!
    expect(WorkspaceRowsSnapshotSchema.parse({ revision: 1, rows: { a: older } }).rows.a).toEqual(
      older
    )
  })

  it('parses what it builds', () => {
    const rows = buildWorkspaceRows({
      worktrees: [worktree({ hostId: 'local' })],
      folderWorkspaces: [folder],
      repos: [localRepo],
      lineageById: {}
    })
    const snapshot = { revision: 1, rows: Object.fromEntries(rows) }
    expect(WorkspaceRowsSnapshotSchema.parse(snapshot)).toEqual(snapshot)
  })

  it('lists the keys it builds rows under, which sleeping retention is matched on', () => {
    const otherRepo: Repo = { ...localRepo, id: 'repo-2', path: '/o' }
    const serverRepo: Repo = { ...localRepo, id: 'repo-3', executionHostId: 'runtime:env' }
    const worktrees = [
      worktree({ id: 'repo-2::/o/a', repoId: 'repo-2' }),
      worktree({ hostId: 'local' }),
      worktree({ hostId: 'ssh:box' }),
      worktree({ id: 'repo-3::/s/a', repoId: 'repo-3' })
    ]
    const repos = [localRepo, sshRepo, otherRepo, serverRepo]
    const keys = listGitWorkspaceRowKeys(worktrees, repos)
    expect(keys).toEqual(['|repo-2::/o/a', 'local|repo-1::/r/a', 'ssh:box|repo-1::/r/a'])
    expect(keys).toEqual([
      ...buildWorkspaceRows({ worktrees, folderWorkspaces: [], repos, lineageById: {} }).keys()
    ])
  })
})
