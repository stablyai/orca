import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusState
} from '../../../../shared/agent-status-types'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'
import {
  buildRetainedAgentsSyncSignature,
  buildRetainedAgentsSyncSnapshot
} from './useRetainedAgents'

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 1
  }
}

function makeWorktree(overrides?: Partial<Worktree>): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/repo/wt-1',
    head: 'abc123',
    branch: 'feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

function makeTab(overrides?: Partial<TerminalTab>): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function makeEntry(args: {
  paneKey: string
  state: AgentStatusState
  updatedAt: number
  stateStartedAt?: number
  prompt?: string
  toolName?: string
}): AgentStatusEntry {
  return {
    state: args.state,
    prompt: args.prompt ?? 'Fix it',
    updatedAt: args.updatedAt,
    stateStartedAt: args.stateStartedAt ?? args.updatedAt,
    paneKey: args.paneKey,
    terminalTitle: 'Claude',
    stateHistory: [],
    agentType: 'claude',
    toolName: args.toolName
  }
}

function makeSyncInputs(entries: Record<string, AgentStatusEntry>) {
  const repo = makeRepo()
  const worktree = makeWorktree()
  const tab = makeTab()
  return {
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    tabsByWorktree: { [worktree.id]: [tab] },
    agentStatusByPaneKey: entries,
    agentStatusEpoch: 1
  }
}

describe('buildRetainedAgentsSyncSignature', () => {
  it('ignores fresh same-state working ping details but changes on state transitions', () => {
    const first = buildRetainedAgentsSyncSignature(
      makeSyncInputs({
        'tab-1:1': makeEntry({
          paneKey: 'tab-1:1',
          state: 'working',
          updatedAt: 1_000,
          stateStartedAt: 1_000,
          prompt: 'one',
          toolName: 'Read'
        })
      })
    )
    const sameState = buildRetainedAgentsSyncSignature(
      makeSyncInputs({
        'tab-1:1': makeEntry({
          paneKey: 'tab-1:1',
          state: 'working',
          updatedAt: 2_000,
          stateStartedAt: 1_000,
          prompt: 'two',
          toolName: 'Edit'
        })
      })
    )
    const done = buildRetainedAgentsSyncSignature(
      makeSyncInputs({
        'tab-1:1': makeEntry({
          paneKey: 'tab-1:1',
          state: 'done',
          updatedAt: 3_000,
          stateStartedAt: 3_000,
          prompt: 'two'
        })
      })
    )

    expect(sameState).toBe(first)
    expect(done).not.toBe(first)
  })

  it('tracks same-state done updates so retention keeps the final snapshot', () => {
    const done = buildRetainedAgentsSyncSignature(
      makeSyncInputs({
        'tab-1:1': makeEntry({
          paneKey: 'tab-1:1',
          state: 'done',
          updatedAt: 3_000,
          stateStartedAt: 3_000
        })
      })
    )
    const updatedDone = buildRetainedAgentsSyncSignature(
      makeSyncInputs({
        'tab-1:1': makeEntry({
          paneKey: 'tab-1:1',
          state: 'done',
          updatedAt: 4_000,
          stateStartedAt: 3_000
        })
      })
    )

    expect(updatedDone).not.toBe(done)
  })
})

describe('buildRetainedAgentsSyncSnapshot', () => {
  it('builds live rows for non-archived worktrees and stale-decays active states', () => {
    const repo = makeRepo()
    const activeWorktree = makeWorktree({ id: 'wt-active' })
    const archivedWorktree = makeWorktree({ id: 'wt-archived', isArchived: true })
    const activeTab = makeTab({ id: 'tab-active', worktreeId: 'wt-active' })
    const archivedTab = makeTab({ id: 'tab-archived', worktreeId: 'wt-archived' })

    const snapshot = buildRetainedAgentsSyncSnapshot({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [activeWorktree, archivedWorktree] },
      tabsByWorktree: {
        [activeWorktree.id]: [activeTab],
        [archivedWorktree.id]: [archivedTab]
      },
      agentStatusByPaneKey: {
        'tab-active:1': makeEntry({
          paneKey: 'tab-active:1',
          state: 'working',
          updatedAt: 10_000,
          stateStartedAt: 10_000
        }),
        'tab-archived:1': makeEntry({
          paneKey: 'tab-archived:1',
          state: 'done',
          updatedAt: 20_000,
          stateStartedAt: 20_000
        })
      },
      now: 10_000 + AGENT_STATUS_STALE_AFTER_MS + 1
    })

    expect([...snapshot.existingWorktreeIds]).toEqual(['wt-active'])
    expect(snapshot.currentAgents.get('tab-active:1')?.row.state).toBe('idle')
    expect(snapshot.currentAgents.get('tab-archived:1')).toBeUndefined()
  })
})
