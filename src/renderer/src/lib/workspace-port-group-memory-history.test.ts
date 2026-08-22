import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EXTERNAL_PORTS_HISTORY_KEY,
  readWorkspacePortMemoryHistory,
  recordWorkspacePortMemorySamples,
  resetWorkspacePortMemoryHistoryForTests
} from './workspace-port-group-memory-history'
import type { WorkspacePortGroup } from './workspace-port-groups'

function group(
  worktreeId: string,
  memoryValues: (number | undefined)[],
  pids: (number | undefined)[] = []
): WorkspacePortGroup {
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
      pid: pids[index],
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

  it('counts a process bound to multiple ports only once', () => {
    // Regression: a dev server on IPv4 + IPv6 reports the same process-level
    // memory on both WorkspacePort rows — summing both double-counts it.
    recordWorkspacePortMemorySamples([group('wt-1', [1000, 1000], [42, 42])], [])

    expect(readWorkspacePortMemoryHistory('wt-1')).toEqual([1000])
  })

  it('still counts a duplicate pid whose first row has no memory sample', () => {
    // Regression: dedup marked the pid "seen" on the first row even when that
    // row had no memory value, so a later row for the same pid with a real
    // value was skipped and the sample undercounted the group's memory.
    recordWorkspacePortMemorySamples([group('wt-1', [undefined, 1000], [42, 42])], [])

    expect(readWorkspacePortMemoryHistory('wt-1')).toEqual([1000])
  })

  it('does not record a false zero sample when every port lacks a memory value', () => {
    // Regression: a failed metadata probe leaves every port's memory
    // undefined; summing that to 0 and recording it looks like a real drop.
    recordWorkspacePortMemorySamples([group('wt-1', [undefined, undefined])], [])

    expect(readWorkspacePortMemoryHistory('wt-1')).toEqual([])
  })

  it('drops a stale ring instead of reviving it when the same group reappears', () => {
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(0)
    recordWorkspacePortMemorySamples([group('wt-1', [1000])], [])

    // Why: the popover was closed for over ten minutes — the ring must not
    // survive with its old sample once a fresh one arrives for the same key.
    nowSpy.mockReturnValue(11 * 60 * 1000)
    recordWorkspacePortMemorySamples([group('wt-1', [2000])], [])

    expect(readWorkspacePortMemoryHistory('wt-1')).toEqual([2000])
    nowSpy.mockRestore()
  })
})
