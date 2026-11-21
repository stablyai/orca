import { describe, expect, it } from 'vitest'
import type { WorktreeMemory } from '../../../../../../shared/diagnostics/process-stats-types'
import type { MergeContext, RuntimeHostResourceSample } from './resource-usage-merge-types'
import { mergeSnapshotAndSessions } from './merge-snapshot-and-sessions'
import { createResourceMergeCache } from './resource-chat-row-groups'

function chatOnly(repoId: string, memory = 4096): WorktreeMemory {
  return {
    worktreeId: `${repoId}::/a`,
    worktreeName: 'a',
    repoId,
    repoName: repoId,
    cpu: 1,
    memory,
    history: [memory],
    sessions: [],
    chats: [{ agentSessionId: 'chat-1', agent: 'claude', name: 'Chat', cpu: 1, memory }]
  }
}

// Catalog maps keep their identity between merges, as the panel's memoized inputs do.
const repoDisplayNameById = new Map<string, string>()
const repoConnectionIdById = new Map<string, string | null>()
const repoRuntimeHostIdById = new Map<string, string>()

function context(
  runtimeHostResources: RuntimeHostResourceSample[],
  overrides: Partial<MergeContext> = {}
): MergeContext {
  return {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    workspaceSessionReady: true,
    repoDisplayNameById,
    repoConnectionIdById,
    repoRuntimeHostIdById,
    runtimeHostResources,
    ...overrides
  }
}

describe('Resource Manager chat row reuse', () => {
  it("keeps one machine's chat-only group, unvisited, when another machine replies", () => {
    const cache = createResourceMergeCache()
    const quietRows = [chatOnly('repo-a')]
    const quiet = { hostId: 'runtime:a', hostLabel: 'A', worktrees: quietRows } as const
    const busy = (memory: number): RuntimeHostResourceSample => ({
      hostId: 'runtime:b',
      hostLabel: 'B',
      worktrees: [chatOnly('repo-b', memory)]
    })
    const first = mergeSnapshotAndSessions(null, [], context([quiet, busy(1)]), undefined, cache)
    let reads = 0
    for (const wt of quietRows) {
      Object.defineProperty(wt, 'worktreeId', {
        get: () => {
          reads++
          return 'runtime:a|repo-a::/a'
        }
      })
    }
    const second = mergeSnapshotAndSessions(null, [], context([quiet, busy(2)]), undefined, cache)
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(reads).toBe(0)
  })

  it('adds a terminal to a copy, so the kept row never gains it twice or keeps it after exit', () => {
    const cache = createResourceMergeCache()
    const host = { hostId: 'runtime:a', hostLabel: 'A', worktrees: [chatOnly('repo-a')] } as const
    const shell = {
      id: 'pty-1',
      worktreeId: 'runtime:a|repo-a::/a',
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
