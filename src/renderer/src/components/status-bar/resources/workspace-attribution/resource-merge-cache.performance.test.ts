import { describe, expect, it } from 'vitest'
import type { WorktreeMemory } from '../../../../../../shared/diagnostics/process-stats-types'
import type { MergeContext, RuntimeHostResourceSample } from './resource-usage-merge-types'
import { mergeSnapshotAndSessions } from './merge-snapshot-and-sessions'
import { createResourceMergeCache } from './resource-merge-cache'

function chatOnly(repoId: string): WorktreeMemory {
  return {
    worktreeId: `${repoId}::/a`,
    worktreeName: 'a',
    repoId,
    repoName: repoId,
    cpu: 1,
    memory: 4096,
    history: [4096],
    sessions: [],
    chats: [{ agentSessionId: 'chat-1', agent: 'claude', name: 'Chat', cpu: 1, memory: 4096 }]
  }
}

function context(runtimeHostResources: RuntimeHostResourceSample[]): MergeContext {
  return {
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    workspaceSessionReady: true,
    repoDisplayNameById: new Map(),
    repoConnectionIdById: new Map(),
    repoRuntimeHostIdById: new Map(),
    runtimeHostResources
  }
}

describe('Resource Manager merge reuse', () => {
  it("keeps one machine's unchanged chat-only group when another machine replies", () => {
    const cache = createResourceMergeCache()
    const quiet = { hostId: 'runtime:a', hostLabel: 'A', worktrees: [chatOnly('repo-a')] } as const
    const busy = (memory: number): RuntimeHostResourceSample => ({
      hostId: 'runtime:b',
      hostLabel: 'B',
      worktrees: [{ ...chatOnly('repo-b'), memory }]
    })
    const first = mergeSnapshotAndSessions(null, [], context([quiet, busy(1)]), undefined, cache)
    const second = mergeSnapshotAndSessions(null, [], context([quiet, busy(2)]), undefined, cache)
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
  })
})
