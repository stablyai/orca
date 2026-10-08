import { describe, expect, it } from 'vitest'
import type { MemorySnapshot, WorktreeMemory } from '../../../../shared/process-stats-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { MergeContext } from './resource-usage-merge-types'
import { mergeSnapshotAndSessions } from './mergeSnapshotAndSessions'

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
    repoRuntimeScopedById: new Map(),
    worktreeById: new Map([
      [workspace.id, workspace],
      [secondWorkspace.id, secondWorkspace]
    ]),
    ...overrides
  }
}

describe('folder Resource Manager rows', () => {
  it('names daemon-only folders using the host-reported workspace identity', () => {
    const groups = mergeSnapshotAndSessions(
      null,
      [
        {
          id: 'folder:notes@@session',
          worktreeId: workspace.id,
          cwd: '/notes',
          title: 'Shell',
          agentOwnership: 'unknown'
        }
      ],
      context()
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      repoId: workspace.repoId,
      repoName: 'Documentation',
      cpu: null,
      memory: null,
      worktrees: [
        {
          worktreeId: workspace.id,
          worktreeName: 'Release notes',
          hasLocalSamples: false,
          isRemote: false,
          sessions: [{ bound: false, agentOwnership: 'unknown' }]
        }
      ]
    })
  })

  it('merges old snapshot labels and daemon-only rows into the same named folder without losing metrics', () => {
    const groups = mergeSnapshotAndSessions(
      { worktrees: [oldRow] } as MemorySnapshot,
      [
        {
          id: 'extra',
          worktreeId: workspace.id,
          cwd: '/notes',
          title: 'Shell',
          agentOwnership: 'present'
        },
        {
          id: 'second',
          worktreeId: secondWorkspace.id,
          cwd: '/research',
          title: 'Shell',
          agentOwnership: 'unknown'
        }
      ],
      context()
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ repoName: 'Documentation', cpu: 2, memory: 2048 })
    expect(groups[0].worktrees).toHaveLength(2)
    expect(groups[0].worktrees[0]).toMatchObject({
      worktreeName: 'Release notes',
      cpu: 2,
      memory: 2048,
      history: [1024, 2048]
    })
    expect(groups[0].worktrees[0].sessions.map((s) => s.sessionId)).toEqual(['sampled', 'extra'])
    expect(groups[0].worktrees[1].worktreeName).toBe('Research')
  })

  it('keeps old snapshot labels when the folder catalog is unavailable', () => {
    const groups = mergeSnapshotAndSessions(
      { worktrees: [oldRow] } as MemorySnapshot,
      [],
      context({ worktreeById: new Map() })
    )
    expect(groups[0].worktrees[0]).toMatchObject({
      worktreeId: workspace.id,
      worktreeName: workspace.id,
      memory: 2048
    })
  })

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

  it('keeps an SSH folder marked remote even without a numeric sample', () => {
    const groups = mergeSnapshotAndSessions(
      null,
      [
        {
          id: 'ssh-folder',
          worktreeId: workspace.id,
          cwd: '/notes',
          title: 'Shell',
          agentOwnership: 'present'
        }
      ],
      context({
        worktreeById: new Map([[workspace.id, { ...workspace, hostId: 'ssh:ssh-target' }]])
      })
    )
    expect(groups[0]).toMatchObject({ hasRemoteChildren: true, memory: null })
    expect(groups[0].worktrees[0]).toMatchObject({ isRemote: true, memory: null })
  })
})
