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
    runtimePaneTitlesByTabId: {},
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
      chats: [chat],
      unplaced: undefined
    })
    expect(rows.find((row) => row.worktreeId === 'runtime:paired|folder:elsewhere')).toMatchObject({
      chats: [chat],
      unplaced: true
    })
  })
})
