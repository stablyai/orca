import { describe, expect, it } from 'vitest'
import type {
  MemorySnapshot,
  WorktreeMemory
} from '../../../../../../shared/diagnostics/process-stats-types'
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

function localSnapshot(worktrees: WorktreeMemory[]): MemorySnapshot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the merge reads only worktrees.
  return { worktrees } as MemorySnapshot
}

function peer(memory: number): RuntimeHostResourceSample {
  return { hostId: 'runtime:b', hostLabel: 'B', worktrees: [sample('/peer', memory, true)] }
}

describe('Resource Manager chat row reuse', () => {
  it("leaves this machine's chat rows unvisited when a paired machine replies", () => {
    const cache = createResourceMergeCache()
    const chats = [sample('/a', 10), sample('/b', 20)]
    const snapshot = localSnapshot(chats)
    const first = mergeSnapshotAndSessions(snapshot, [], context([peer(1)]), undefined, cache)
    const counter = countReads(chats)
    const second = mergeSnapshotAndSessions(snapshot, [], context([peer(2)]), undefined, cache)
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(counter.reads).toBe(0)
  })

  it('keeps unchanged chat rows when a fresh sample arrives, and redraws only the one that changed', () => {
    const cache = createResourceMergeCache()
    const fresh = (bMemory: number) => localSnapshot([sample('/a', 10), sample('/b', bMemory)])
    const [first] = mergeSnapshotAndSessions(fresh(20), [], context([]), undefined, cache)
    const [same] = mergeSnapshotAndSessions(fresh(20), [], context([]), undefined, cache)
    expect(same).toBe(first)

    const [changed] = mergeSnapshotAndSessions(fresh(30), [], context([]), undefined, cache)
    expect(changed.worktrees[0]).toBe(first.worktrees[0])
    expect(changed.worktrees[1]).not.toBe(first.worktrees[1])
    expect(changed.worktrees[1].memory).toBe(30)
  })

  it("keeps a terminal workspace's unchanged chats when a fresh sample arrives", () => {
    const cache = createResourceMergeCache()
    const mixed = (secondMemory: number): MemorySnapshot => {
      const row = sample('/m', 10, true)
      const chat = (id: string, memory: number) => ({
        agentSessionId: id,
        agent: 'claude',
        name: 'Chat',
        cpu: 1,
        memory
      })
      return localSnapshot([{ ...row, chats: [chat('chat-a', 5), chat('chat-b', secondMemory)] }])
    }
    const chatsOf = (memory: number) =>
      mergeSnapshotAndSessions(mixed(memory), [], context([]), undefined, cache)[0].worktrees[0]
        .chats
    const first = chatsOf(5)
    expect(chatsOf(5)).toBe(first)

    const changed = chatsOf(6)
    expect(changed).not.toBe(first)
    expect(changed?.[0]).toBe(first?.[0])
    expect(changed?.[1].memory).toBe(6)
  })

  it('rebuilds only terminal rows of a mixed project when a tab title is stored', () => {
    const cache = createResourceMergeCache()
    const chats = [sample('/a', 10), sample('/b', 20)]
    const snapshot = localSnapshot([...chats, sample('/t', 5, true)])
    const [first] = mergeSnapshotAndSessions(snapshot, [], context([]), undefined, cache)
    const counter = countReads(chats)
    const [second] = mergeSnapshotAndSessions(snapshot, [], context([], {}), undefined, cache)
    expect(counter.reads).toBe(0)
    const chatRow = (rows: typeof first.worktrees) =>
      rows.find((row) => row.worktreeId === 'repo::/a')
    expect(chatRow(second.worktrees)).toBe(chatRow(first.worktrees))
    expect(second.memory).toBe(35)
  })

  it('adds a terminal to a copy, so the kept row never gains it twice or keeps it after exit', () => {
    const cache = createResourceMergeCache()
    const snapshot = localSnapshot([sample('/a', 10)])
    const shell = {
      id: 'pty-1',
      worktreeId: 'repo::/a',
      cwd: '/a',
      title: 'Shell',
      agentOwnership: 'absent'
    } as const
    const [plain] = mergeSnapshotAndSessions(snapshot, [], context([]), undefined, cache)
    mergeSnapshotAndSessions(snapshot, [shell], context([]), undefined, cache)
    const [again] = mergeSnapshotAndSessions(snapshot, [shell], context([]), undefined, cache)
    const [exited] = mergeSnapshotAndSessions(snapshot, [], context([]), undefined, cache)
    expect(again.worktrees[0].sessions.map((s) => s.sessionId)).toEqual(['pty-1'])
    expect(exited).toBe(plain)
    expect(plain.worktrees[0].sessions).toEqual([])
  })
})
