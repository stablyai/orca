import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab, Worktree } from '../../../../shared/types'

const batchMocks = vi.hoisted(() => ({
  release: vi.fn(),
  select: vi.fn(() => new Map())
}))

vi.mock('../sidebar/worktree-agent-orchestration-batch', () => ({
  EMPTY_WORKTREE_AGENT_ORCHESTRATION: {},
  releaseRuntimeAgentOrchestrationBatchCache: batchMocks.release,
  selectRuntimeAgentOrchestrationBatch: batchMocks.select
}))

import { buildDashboardSnapshot, type DashboardSnapshotState } from './build-dashboard-snapshot'

function worktree(index: number): Worktree {
  return {
    id: `w${index}`,
    repoId: 'r1',
    path: `/r1/w${index}`,
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName: `wt-${index}`,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: index,
    lastActivityAt: 1
  }
}

function tab(index: number): TerminalTab {
  return {
    id: `tab-${index}`,
    ptyId: null,
    worktreeId: `w${index}`,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function state(
  worktreeCount: number,
  runtimeAgentOrchestrationByPaneKey: Record<string, AgentStatusOrchestrationContext>
): DashboardSnapshotState {
  const worktrees = Array.from({ length: worktreeCount }, (_, index) => worktree(index))
  return {
    repos: [{ id: 'r1', path: '/r1', displayName: 'Repo One', badgeColor: '#000' }],
    worktreesByRepo: { r1: worktrees },
    tabsByWorktree: Object.fromEntries(
      worktrees.map((currentWorktree, index) => [currentWorktree.id, [tab(index)]])
    ),
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey,
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    acknowledgedAgentsByPaneKey: {}
  } as unknown as DashboardSnapshotState
}

describe('buildDashboardSnapshot orchestration routing', () => {
  beforeEach(() => {
    batchMocks.release.mockClear()
    batchMocks.select.mockClear()
  })

  it('keeps the production singleton on one legacy runtime pass', () => {
    const contextCount = 8
    let runtimeEnumerations = 0
    let runtimeValueReads = 0
    let contextVisits = 0
    const runtimeRecords: Record<string, AgentStatusOrchestrationContext> = {}
    for (let index = 0; index < contextCount; index += 1) {
      const paneKey = makePaneKey(
        'tab-0',
        `88888888-8888-4888-8888-${index.toString(16).padStart(12, '0')}`
      )
      runtimeRecords[paneKey] = {
        taskId: `task-${index}`,
        dispatchId: `dispatch-${index}`,
        get parentPaneKey() {
          contextVisits += 1
          return undefined
        }
      }
    }
    const runtime = new Proxy(runtimeRecords, {
      ownKeys(target) {
        runtimeEnumerations += 1
        return Reflect.ownKeys(target)
      },
      get(target, key, receiver) {
        if (typeof key === 'string' && Object.hasOwn(target, key)) {
          runtimeValueReads += 1
        }
        return Reflect.get(target, key, receiver)
      }
    })

    buildDashboardSnapshot(state(1, runtime), 1)

    expect(batchMocks.release).toHaveBeenCalledOnce()
    expect(batchMocks.select).not.toHaveBeenCalled()
    expect({ runtimeEnumerations, runtimeValueReads, contextVisits }).toEqual({
      runtimeEnumerations: 1,
      runtimeValueReads: contextCount,
      contextVisits: contextCount
    })
  })

  it('releases batch state without reading runtime when no worktree is active', () => {
    const runtime = new Proxy<Record<string, AgentStatusOrchestrationContext>>(
      {},
      {
        ownKeys() {
          throw new Error('zero-worktree build must not enumerate runtime')
        }
      }
    )

    buildDashboardSnapshot(state(0, runtime), 1)

    expect(batchMocks.release).toHaveBeenCalledOnce()
    expect(batchMocks.select).not.toHaveBeenCalled()
  })

  it('uses the explicit batch only when at least two worktrees are active', () => {
    const currentState = state(2, {})

    buildDashboardSnapshot(currentState, 1)

    expect(batchMocks.release).not.toHaveBeenCalled()
    expect(batchMocks.select).toHaveBeenCalledOnce()
    expect(batchMocks.select).toHaveBeenCalledWith(currentState, ['w0', 'w1'])
  })
})
