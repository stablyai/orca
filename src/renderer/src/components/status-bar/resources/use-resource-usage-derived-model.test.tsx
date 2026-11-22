// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { WorktreeMemory } from '../../../../../shared/diagnostics/process-stats-types'
import { useResourceUsageDerivedModel } from './use-resource-usage-derived-model'

const row = (id: string, sessions: number): WorktreeMemory => ({
  worktreeId: id,
  worktreeName: id,
  repoId: 'repo',
  repoName: 'Repo',
  cpu: 10,
  memory: 100,
  history: [],
  sessions: Array.from({ length: sessions }, (_, i) => ({
    sessionId: `${id}-${i}`,
    paneKey: null,
    pid: i + 1,
    cpu: 1,
    memory: 1
  }))
})

function derive(sessionCount: number | null) {
  return renderHook(() =>
    useResourceUsageDerivedModel({
      open: true,
      resourceSnapshot: null,
      runtimeHostResources: [
        { hostId: 'runtime:one', hostLabel: 'One', worktrees: [row('a', 2), row('b', 1)] },
        { hostId: 'runtime:two', hostLabel: 'Two', worktrees: [row('c', 4)] }
      ],
      sessions: [],
      resourceSessionBindings: {
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        workspaceSessionReady: true
      },
      runtimePaneTitlesByTabId: {},
      repos: [],
      allWorktrees: [],
      projectGroups: [],
      browserTabsByWorktree: {},
      workspaceSessionReady: true,
      sessionCount,
      sessionsError: false,
      memorySnapshotError: null,
      snapshot: null,
      spaceScanReady: false
    })
  )
}

describe('paired-server count', () => {
  it('adds sampled server sessions', () => {
    const { result } = derive(1)
    expect(result.current.triggerSessionCount).toBe(8)
  })
  it('keeps null when local count unknown', () => {
    expect(derive(null).result.current.triggerSessionCount).toBeNull()
  })
})
