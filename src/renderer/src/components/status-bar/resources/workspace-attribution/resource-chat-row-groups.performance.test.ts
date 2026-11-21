import { describe, expect, it } from 'vitest'
import type { WorktreeMemory } from '../../../../../../shared/diagnostics/process-stats-types'
import type { MergeContext, RuntimeHostResourceSample } from './resource-usage-merge-types'
import { mergeSnapshotAndSessions } from './merge-snapshot-and-sessions'
import { createResourceMergeCache } from './resource-chat-row-groups'

function sample(path: string, memory: number, terminal = false): WorktreeMemory {
  return {
    worktreeId: `repo::${path}`,
    worktreeName: path,
    repoId: 'repo',
    repoName: 'repo',
    cpu: 1,
    memory,
    history: [memory],
    sessions: terminal ? [{ sessionId: `pty-${path}`, paneKey: null, pid: 7, cpu: 1, memory }] : [],
    chats: terminal
      ? undefined
      : [{ agentSessionId: `chat-${path}`, agent: 'claude', name: 'Chat', cpu: 1, memory }]
  }
}

/** Counts reads of the fields a merge would touch to place or total a row. */
function countReads(rows: WorktreeMemory[]): { reads: number } {
  const counter = { reads: 0 }
  for (const row of rows) {
    for (const key of ['worktreeId', 'sessions', 'cpu', 'memory'] as const) {
      const value = row[key]
      Object.defineProperty(row, key, {
        get: () => {
          counter.reads++
          return value
        }
      })
    }
  }
  return counter
}

// Catalog maps keep their identity between merges, as the panel's memoized inputs do.
const repoDisplayNameById = new Map<string, string>()
const repoConnectionIdById = new Map<string, string | null>()
const repoRuntimeHostIdById = new Map<string, string>()

function context(
  runtimeHostResources: RuntimeHostResourceSample[],
  tabsByWorktree: MergeContext['tabsByWorktree'] = {}
): MergeContext {
  return {
    tabsByWorktree,
    ptyIdsByTabId: {},
    workspaceSessionReady: true,
    repoDisplayNameById,
    repoConnectionIdById,
    repoRuntimeHostIdById,
    runtimeHostResources
  }
}

describe('Resource Manager chat row reuse', () => {
  it("leaves one machine's chat rows unvisited when another machine replies", () => {
    const cache = createResourceMergeCache()
    const chats = [sample('/a', 10), sample('/b', 20)]
    const quiet = { hostId: 'runtime:a', hostLabel: 'A', worktrees: chats } as const
    const busy = (memory: number): RuntimeHostResourceSample => ({
      hostId: 'runtime:b',
      hostLabel: 'B',
      worktrees: [sample('/c', memory)]
    })
    const first = mergeSnapshotAndSessions(null, [], context([quiet, busy(1)]), undefined, cache)
    const counter = countReads(chats)
    const second = mergeSnapshotAndSessions(null, [], context([quiet, busy(2)]), undefined, cache)
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(counter.reads).toBe(0)
  })

  it('rebuilds only terminal rows of a mixed project when a tab title is stored', () => {
    const cache = createResourceMergeCache()
    const chats = [sample('/a', 10), sample('/b', 20)]
    const host = {
      hostId: 'runtime:a',
      hostLabel: 'A',
      worktrees: [...chats, sample('/t', 5, true)]
    } as const
    const [first] = mergeSnapshotAndSessions(null, [], context([host]), undefined, cache)
    const counter = countReads(chats)
    const [second] = mergeSnapshotAndSessions(null, [], context([host], {}), undefined, cache)
    expect(counter.reads).toBe(0)
    expect(second.worktrees.slice(0, 2)).toEqual(first.worktrees.slice(0, 2))
    expect(second.worktrees[0]).toBe(first.worktrees[0])
    expect(second.memory).toBe(35)
  })

  it('adds a terminal to a copy, so the kept row never gains it twice or keeps it after exit', () => {
    const cache = createResourceMergeCache()
    const host = { hostId: 'runtime:a', hostLabel: 'A', worktrees: [sample('/a', 10)] } as const
    const shell = {
      id: 'pty-1',
      worktreeId: 'runtime:a|repo::/a',
      cwd: '/a',
      title: 'Shell',
      agentOwnership: 'absent'
    } as const
    const [plain] = mergeSnapshotAndSessions(null, [], context([host]), undefined, cache)
    mergeSnapshotAndSessions(null, [shell], context([host]), undefined, cache)
    const [again] = mergeSnapshotAndSessions(null, [shell], context([host]), undefined, cache)
    const [exited] = mergeSnapshotAndSessions(null, [], context([host]), undefined, cache)
    expect(again.worktrees[0].sessions.map((s) => s.sessionId)).toEqual(['pty-1'])
    expect(exited).toBe(plain)
    expect(plain.worktrees[0].sessions).toEqual([])
  })
})
