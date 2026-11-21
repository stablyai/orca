import { describe, expect, it } from 'vitest'
import type {
  MemorySnapshot,
  WorktreeMemory
} from '../../../../../../shared/diagnostics/process-stats-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { MergeContext } from './resource-usage-merge-types'
import { mergeSnapshotAndSessions } from './merge-snapshot-and-sessions'

const workspace = {
  id: 'folder:notes',
  repoId: 'folder-workspace:docs',
  displayName: 'Release notes'
} as Worktree
const secondWorkspace = { ...workspace, id: 'folder:research', displayName: 'Research' }
const oldRow: WorktreeMemory = {
  worktreeId: workspace.id,
  worktreeName: workspace.id,
  repoId: workspace.id,
  repoName: workspace.id,
  cpu: 2,
  memory: 2048,
  history: [1024, 2048],
  sessions: [{ sessionId: 'sampled', paneKey: null, pid: 123, cpu: 2, memory: 2048 }]
}

function context(overrides: Partial<MergeContext> = {}): MergeContext {
  return {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    workspaceSessionReady: true,
    repoDisplayNameById: new Map([[workspace.repoId, 'Documentation']]),
    repoConnectionIdById: new Map(),
    repoRuntimeHostIdById: new Map(),
    worktreeById: new Map([
      [workspace.id, workspace],
      [secondWorkspace.id, secondWorkspace]
    ]),
    ...overrides
  }
}

describe('folder Resource Manager rows', () => {
  it('excludes runtime-owned folder sessions from local snapshot and daemon inputs', () => {
    expect(
      mergeSnapshotAndSessions(
        { worktrees: [oldRow] } as MemorySnapshot,
        [
          {
            id: 'foreign',
            worktreeId: workspace.id,
            cwd: '/notes',
            title: 'Shell',
            agentOwnership: 'present'
          }
        ],
        context({
          worktreeById: new Map([[workspace.id, { ...workspace, hostId: 'runtime:paired' }]])
        })
      )
    ).toEqual([])
  })

  it("opens a paired folder workspace's chats only when this window places it on that machine", () => {
    const chat = { agentSessionId: 'chat-1', agent: 'claude', name: 'Plan', cpu: 1, memory: 512 }
    const paired = (worktreeId: string): WorktreeMemory => ({
      ...oldRow,
      worktreeId,
      chats: [chat]
    })
    const repos = mergeSnapshotAndSessions(
      null,
      [],
      context({
        worktreeById: new Map([[workspace.id, { ...workspace, hostId: 'runtime:paired' }]]),
        runtimeHostResources: [
          {
            hostId: 'runtime:paired',
            hostLabel: 'Studio',
            worktrees: [paired(workspace.id), paired('folder:elsewhere')]
          }
        ]
      })
    )
    const rows = repos.flatMap((repo) => repo.worktrees)

    expect(rows.find((row) => row.worktreeId === workspace.id)).toMatchObject({
      chats: [{ agentSessionId: 'chat-1', agent: 'claude', name: 'Plan', cpu: 1, memory: 512 }],
      unplaced: undefined
    })
    expect(rows.find((row) => row.worktreeId === 'runtime:paired|folder:elsewhere')).toMatchObject({
      chats: [{ agentSessionId: 'chat-1', agent: 'claude', name: 'Plan', cpu: 1, memory: 512 }],
      unplaced: true
    })
  })

  it("keeps a paired repo's chats read-only until this window lists the worktree", () => {
    const chat = { agentSessionId: 'chat-2', agent: 'codex', name: null, cpu: 1, memory: 256 }
    const repos = mergeSnapshotAndSessions(
      null,
      [],
      context({
        repoRuntimeHostIdById: new Map([['repo-1', 'runtime:paired']]),
        runtimeHostResources: [
          {
            hostId: 'runtime:paired',
            hostLabel: 'Studio',
            worktrees: [{ ...oldRow, worktreeId: 'repo-1::/new', repoId: 'repo-1', chats: [chat] }]
          }
        ]
      })
    )

    expect(
      repos.flatMap((repo) => repo.worktrees).find((row) => row.worktreeId === 'repo-1::/new')
    ).toMatchObject({
      chats: [{ agentSessionId: 'chat-2', agent: 'codex', name: null, cpu: 1, memory: 256 }],
      unplaced: true
    })
  })

  it('opens chats in a worktree this window placed on a paired machine whose repo is local', () => {
    const chat = { agentSessionId: 'chat-3', agent: 'claude', name: null, cpu: 1, memory: 256 }
    const worktree: Worktree = {
      ...workspace,
      id: 'repo-1::/remote',
      repoId: 'repo-1',
      displayName: 'Remote',
      hostId: 'runtime:wsl:Ubuntu'
    }
    // A local sample of the same id (an older placement) must not add a second row.
    const repos = mergeSnapshotAndSessions(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the merge reads only worktrees.
      { worktrees: [{ ...oldRow, worktreeId: worktree.id, repoId: 'repo-1' }] } as MemorySnapshot,
      [],
      context({
        worktreeById: new Map([[worktree.id, worktree]]),
        runtimeHostResources: [
          {
            hostId: 'runtime:wsl%3AUbuntu',
            hostLabel: 'Studio',
            worktrees: [{ ...oldRow, worktreeId: worktree.id, repoId: 'repo-1', chats: [chat] }]
          }
        ]
      })
    )

    expect(repos.flatMap((repo) => repo.worktrees)).toEqual([
      expect.objectContaining({
        worktreeId: 'repo-1::/remote',
        runtimeHostId: 'runtime:wsl%3AUbuntu',
        unplaced: undefined
      })
    ])
  })

  it("keeps a duplicated worktree id's chats read-only even when its repo is on the paired machine", () => {
    const chat = { agentSessionId: 'chat-4', agent: 'codex', name: null, cpu: 1, memory: 256 }
    const repos = mergeSnapshotAndSessions(
      null,
      [],
      context({
        repoRuntimeHostIdById: new Map([['repo-1', 'runtime:paired']]),
        worktreeById: new Map([['repo-1::/twin', { ...workspace, id: 'repo-1::/twin' }]]),
        ambiguousWorktreeIds: new Set(['repo-1::/twin']),
        runtimeHostResources: [
          {
            hostId: 'runtime:paired',
            hostLabel: 'Studio',
            worktrees: [{ ...oldRow, worktreeId: 'repo-1::/twin', repoId: 'repo-1', chats: [chat] }]
          }
        ]
      })
    )

    expect(repos.flatMap((repo) => repo.worktrees)).toEqual([
      expect.objectContaining({ worktreeId: 'repo-1::/twin', unplaced: true })
    ])
  })
})
