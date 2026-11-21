import { describe, expect, it, vi } from 'vitest'
import type {
  MemorySnapshot,
  WorktreeMemory
} from '../../../../../../shared/diagnostics/process-stats-types'
import { readRuntimeHostResources } from '../../host-connections/runtime-host-resources'
import { sharedAgentProcessUsage } from './resource-owner-split'

function terminalOnlyWorktrees(count: number): WorktreeMemory[] {
  return Array.from({ length: count }, (_, i) => ({
    worktreeId: `repo::/w${i}`,
    worktreeName: `w${i}`,
    repoId: 'repo',
    repoName: 'repo',
    cpu: 1,
    memory: 1_000,
    sessions: [{ sessionId: `s${i}`, paneKey: null, pid: 100 + i, cpu: 1, memory: 1_000 }],
    history: []
  }))
}

describe('terminal-only Resource Manager samples pay nothing for chats', () => {
  it.each([300, 3_000])('skips the shared-agent pass with no agents (%i workspaces)', (count) => {
    const isListed = vi.fn(() => true)
    let visited = 0
    const worktrees = terminalOnlyWorktrees(count).map((worktree) =>
      Object.defineProperty(worktree, 'chats', {
        get: () => {
          visited += 1
          return undefined
        }
      })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared-agent pass reads only worktrees and agentProcesses.
    const snapshot = {
      worktrees,
      agentProcesses: { cpu: 0, memory: 0 }
    } as unknown as MemorySnapshot

    expect(sharedAgentProcessUsage(snapshot, isListed)).toBeNull()
    expect(visited).toBe(0)
    expect(isListed).not.toHaveBeenCalled()
  })

  it.each([300, 3_000])(
    'parses a paired reply with no chat lists (%i workspaces)',
    async (count) => {
      const result = await readRuntimeHostResources('env', async () => ({
        worktrees: terminalOnlyWorktrees(count).map((worktree, i) =>
          i % 2 === 0 ? worktree : { ...worktree, chats: [] }
        )
      }))

      expect(result.status).toBe('sampled')
      const worktrees = result.status === 'sampled' ? result.worktrees : []
      expect(worktrees).toHaveLength(count)
      expect(worktrees.filter((worktree) => worktree.chats !== undefined)).toHaveLength(0)
    }
  )
})
