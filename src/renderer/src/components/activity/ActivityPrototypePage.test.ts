import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'
import { buildActivityEvents } from './ActivityPrototypePage'

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 1
  }
}

function makeWorktree(): Worktree {
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
    lastActivityAt: 1
  }
}

function makeTab(): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeWorkingEntryWithPriorDone(): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'Second prompt',
    updatedAt: 2_000,
    stateStartedAt: 2_000,
    paneKey: 'tab-1:1',
    terminalTitle: 'Claude',
    stateHistory: [
      {
        state: 'done',
        prompt: 'First prompt',
        startedAt: 1_000
      }
    ],
    agentType: 'claude'
  }
}

describe('buildActivityEvents', () => {
  it('keeps a prior done event after the same pane starts working again', () => {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const tab = makeTab()

    const events = buildActivityEvents({
      agentStatusByPaneKey: {
        'tab-1:1': makeWorkingEntryWithPriorDone()
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: {
        [worktree.id]: [tab]
      },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {}
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      state: 'done',
      timestamp: 1_000
    })
    expect(events[0].entry.prompt).toBe('First prompt')
  })
})
