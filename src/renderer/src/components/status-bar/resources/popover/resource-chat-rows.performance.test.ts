import { describe, expect, it, vi } from 'vitest'
import type {
  MemorySnapshot,
  WorktreeMemory
} from '../../../../../../shared/diagnostics/process-stats-types'
import {
  readRuntimeHostResources,
  withRuntimeHostResult
} from '../../host-connections/runtime-host-resources'
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

    expect(sharedAgentProcessUsage(snapshot)).toBeNull()
    expect(visited).toBe(0)
  })

  it('never parses a paired reply that arrives after the view closed', async () => {
    const parsedRows = vi.fn()
    const result = await readRuntimeHostResources(
      'env',
      async () => ({
        get worktrees() {
          parsedRows()
          return terminalOnlyWorktrees(300)
        }
      }),
      () => false
    )

    expect(result).toBeNull()
    expect(parsedRows).not.toHaveBeenCalled()
  })

  it('keeps the same state when a host fails the same way again', () => {
    const first = withRuntimeHostResult({ key: null, results: {} }, 'k', 'studio', {
      status: 'unreachable'
    })
    const again = withRuntimeHostResult(first, 'k', 'studio', { status: 'unreachable' })
    const recovered = withRuntimeHostResult(again, 'k', 'studio', {
      status: 'sampled',
      worktrees: []
    })

    expect(again).toBe(first)
    expect(recovered).not.toBe(first)
    expect(recovered.results.studio).toEqual({ status: 'sampled', worktrees: [] })
  })
})
