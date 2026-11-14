// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type { MemorySnapshot, WorktreeMemory } from '../../../../../shared/process-stats-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { ProjectGroup } from '../../../../../shared/project-group-types'
import type { PtyListedSession as DaemonSession } from '../../../../../shared/terminal/pty/lifecycle/pty-listed-session'
import { useResourceUsageDerivedModel } from './use-resource-usage-derived-model'

const local = {
  id: 'folder:local',
  repoId: 'folder-workspace:group',
  displayName: 'Local notes',
  hostId: 'local'
} as Worktree
const sampled: WorktreeMemory = {
  worktreeId: local.id,
  worktreeName: 'Published local notes',
  repoId: local.repoId,
  repoName: 'Local project',
  cpu: 2,
  memory: 2048,
  history: [1024, 2048],
  sessions: [{ sessionId: 'sampled', paneKey: null, pid: 123, cpu: 2, memory: 2048 }]
}
const group = { id: 'group', name: 'Local project', executionHostId: 'local' } as ProjectGroup

function derive(
  worktrees: Worktree[],
  sessions: DaemonSession[] = [],
  row = sampled,
  projectGroups = [group],
  browserTabsByWorktree: Record<string, BrowserWorkspace[]> = {}
) {
  const snapshot = {
    worktrees: [row],
    host: { totalMemory: 16384 },
    totalMemory: 2048,
    totalCpu: 2,
    processMemoryMetric: 'rss'
  } as MemorySnapshot
  return renderHook(() =>
    useResourceUsageDerivedModel({
      open: true,
      resourceSnapshot: snapshot,
      runtimeHostResources: [],
      sessions,
      resourceSessionBindings: {
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        workspaceSessionReady: true
      },
      runtimePaneTitlesByTabId: {},
      repos: [],
      allWorktrees: worktrees,
      projectGroups,
      browserTabsByWorktree,
      workspaceSessionReady: true,
      sessionCount: sessions.length,
      sessionsError: false,
      memorySnapshotError: null,
      snapshot,
      spaceScanReady: false
    })
  ).result.current.unifiedRepos
}

afterEach(cleanup)

describe('Resource Manager folder ownership', () => {
  it.each(['repo::/notes', 'folder:shared'])(
    'keeps browser-only rows when %s exists on two hosts',
    (worktreeId) => {
      const here = { ...local, id: worktreeId, repoId: 'repo', displayName: 'Notes' } as Worktree
      const there = { ...here, hostId: 'ssh:box' } as Worktree
      const browser = { id: 'browser-1', worktreeId, title: 'Docs' } as BrowserWorkspace
      const groups = derive([here, there], [], sampled, [group], { [worktreeId]: [browser] })

      expect(groups.find((project) => project.repoId === 'repo')).toMatchObject({
        worktrees: [{ worktreeId, isRemote: false, browsers: [browser] }]
      })
    }
  )

  it('keeps git snapshot identity when the catalog contains a different host', () => {
    const row = { ...sampled, worktreeId: 'repo::/notes', repoId: 'repo' }
    const foreign = {
      ...local,
      id: row.worktreeId,
      repoId: 'foreign-repo',
      displayName: 'Foreign notes',
      hostId: 'runtime:paired'
    } as Worktree
    const groups = derive([foreign], [], row)

    expect(groups[0]).toMatchObject({ repoId: row.repoId, repoName: row.repoName, memory: 2048 })
    expect(groups[0].worktrees[0].worktreeName).toBe(row.worktreeName)
  })

  it('keeps git daemon identity when the catalog contains a different host', () => {
    const worktreeId = 'repo::/notes'
    const foreign = {
      ...local,
      id: worktreeId,
      repoId: 'foreign-repo',
      displayName: 'Foreign notes',
      hostId: 'runtime:paired'
    } as Worktree
    const groups = derive(
      [foreign],
      [{ id: 'git-session', worktreeId, cwd: '/notes', title: '', agentOwnership: 'absent' }]
    )

    expect(groups.find((project) => project.repoId === 'repo')).toMatchObject({
      repoName: 'repo',
      worktrees: [{ worktreeId, worktreeName: 'notes', isRemote: false }]
    })
    expect(groups.some((project) => project.repoId === foreign.repoId)).toBe(false)
  })
})
