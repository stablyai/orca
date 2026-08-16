import { afterEach, describe, expect, it } from 'vitest'
import {
  EXTERNAL_PORTS_HISTORY_KEY,
  readWorkspacePortMemoryHistory,
  recordWorkspacePortMemorySamples,
  resetWorkspacePortMemoryHistoryForTests
} from './workspace-port-group-memory-history'
import type { WorkspacePortGroup } from './workspace-port-groups'

function group(worktreeId: string, memoryValues: number[]): WorkspacePortGroup {
  return {
    worktreeId,
    repoId: 'repo',
    displayName: worktreeId,
    ports: memoryValues.map((memory, index) => ({
      id: `${worktreeId}-${index}`,
      bindHost: '127.0.0.1',
      connectHost: '127.0.0.1',
      port: 3000 + index,
      protocol: 'http' as const,
      kind: 'workspace' as const,
      memory,
      owner: {
        worktreeId,
        repoId: 'repo',
        displayName: worktreeId,
        path: '/repo',
        confidence: 'cwd'
      }
    }))
  }
}

describe('workspace port group memory history', () => {
  afterEach(() => {
    resetWorkspacePortMemoryHistoryForTests()
  })

  it('sums per-port memory into one sample per group', () => {
    recordWorkspacePortMemorySamples([group('wt-1', [1000, 2000])], [])

    expect(readWorkspacePortMemoryHistory('wt-1')).toEqual([3000])
  })

  it('appends across calls instead of overwriting', () => {
    recordWorkspacePortMemorySamples([group('wt-1', [1000])], [])
    recordWorkspacePortMemorySamples([group('wt-1', [1500])], [])

    expect(readWorkspacePortMemoryHistory('wt-1')).toEqual([1000, 1500])
  })

  it('records external ports under a separate key, only when non-empty', () => {
    recordWorkspacePortMemorySamples([], [{ memory: 500 }, { memory: 250 }])
    recordWorkspacePortMemorySamples([], [])

    // Why: an empty external list must not push a spurious zero sample that
    // would flatten the sparkline while nothing external is actually running.
    expect(readWorkspacePortMemoryHistory(EXTERNAL_PORTS_HISTORY_KEY)).toEqual([750])
  })

  it('returns an empty array for a key with no recorded samples', () => {
    expect(readWorkspacePortMemoryHistory('unknown')).toEqual([])
  })
})
