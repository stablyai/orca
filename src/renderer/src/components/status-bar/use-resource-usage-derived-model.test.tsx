// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemorySnapshot, WorktreeMemory } from '../../../../shared/process-stats-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { DaemonSession } from './resource-usage-merge-types'
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
  projectGroups = [group]
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
      browserTabsByWorktree: {},
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
  it.each(['ssh:box', 'runtime:paired'] as const)(
    'keeps local samples when a sibling folder belongs to %s',
    (hostId) => {
      const sibling = { ...local, id: 'folder:remote', displayName: 'Remote notes', hostId }
      const groups = derive(
        [local, sibling],
        [
          {
            id: 'remote-session',
            worktreeId: sibling.id,
            cwd: '/notes',
            title: 'Shell',
            agentOwnership: 'present'
          }
        ]
      )

      expect(groups).toHaveLength(1)
      expect(groups[0]).toMatchObject({
        cpu: 2,
        memory: 2048,
        hasRemoteChildren: hostId === 'ssh:box'
      })
      expect(groups[0].worktrees[0]).toMatchObject({
        worktreeId: local.id,
        worktreeName: local.displayName,
        isRemote: false,
        cpu: 2,
        memory: 2048,
        sessions: [{ sessionId: 'sampled', memory: 2048 }]
      })
      if (hostId === 'ssh:box') {
        expect(groups[0].worktrees[1]).toMatchObject({
          worktreeId: sibling.id,
          isRemote: true,
          cpu: null,
          memory: null
        })
      } else {
        expect(groups[0].worktrees).toHaveLength(1)
      }
    }
  )

  it.each([false, true])(
    'preserves sampled ownership with duplicate folder ids (reverse=%s)',
    (reverse) => {
      const remote = {
        ...local,
        repoId: 'folder-workspace:remote',
        displayName: 'Foreign notes',
        hostId: 'runtime:paired'
      } as Worktree
      const groups = derive(reverse ? [remote, local] : [local, remote])

      expect(groups).toHaveLength(1)
      expect(groups[0]).toMatchObject({
        repoId: sampled.repoId,
        repoName: sampled.repoName,
        memory: 2048
      })
      expect(groups[0].worktrees[0]).toMatchObject({
        worktreeName: sampled.worktreeName,
        isRemote: false,
        memory: 2048,
        history: sampled.history
      })
    }
  )

  it('does not replace a sampled project name with a same-id group from another host', () => {
    const foreignGroup = { ...group, name: 'Foreign project', executionHostId: 'runtime:paired' }
    const groups = derive([local], [], sampled, [group, foreignGroup])
    expect(groups[0].repoName).toBe('Local project')
  })

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
