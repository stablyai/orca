import { describe, expect, it } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import type { RuntimeWorktreePsSummary } from '../../../../shared/runtime-worktree-contracts'
import {
  buildMobileWorkspaces,
  formatMobileRelativeTime,
  mobileAgentLabel,
  mobileSessionStatus,
  mobileSessionTitle
} from './mobile-remote-model'

function worktree(overrides: Partial<RuntimeWorktreePsSummary>): RuntimeWorktreePsSummary {
  return {
    worktreeId: 'wt-1',
    repoId: 'repo-1',
    repo: 'orca',
    path: '/code/orca',
    branch: 'main',
    isArchived: false,
    isMainWorktree: false,
    hasHostSidebarActivity: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    displayName: 'Orca Core',
    workspaceStatus: 'active',
    sortOrder: 0,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isPinned: false,
    isActive: false,
    unread: false,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    lastOutputAt: null,
    preview: '',
    status: 'inactive',
    agents: [],
    ...overrides
  }
}

function session(overrides: Partial<AgentSessionStatusSummary>): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: 'wt-1',
    agent: 'codex',
    status: 'idle',
    latestPrompt: 'Fix the tunnel',
    updatedAt: 1_000,
    ...overrides
  }
}

describe('buildMobileWorkspaces', () => {
  it('joins sessions by workspace and sorts attention ahead of working and idle', () => {
    const result = buildMobileWorkspaces({
      worktrees: [
        worktree({ worktreeId: 'wt-1', displayName: 'Orca Core', lastActivityAt: 50 }),
        worktree({ worktreeId: 'wt-2', displayName: 'Empty Project', lastActivityAt: 1 })
      ],
      sessions: [
        session({ sessionId: 'idle', status: 'idle', updatedAt: 3_000 }),
        session({ sessionId: 'working', status: 'working', updatedAt: 2_000 }),
        session({ sessionId: 'attention', status: 'attention', updatedAt: 1_000 })
      ]
    })

    expect(result.map((group) => group.workspaceId)).toEqual(['wt-1', 'wt-2'])
    expect(result[0]?.sessions.map((entry) => entry.sessionId)).toEqual([
      'attention',
      'working',
      'idle'
    ])
    expect(result[1]?.sessions).toEqual([])
  })

  it('keeps sessions whose workspace is missing from the catalog under Other tasks', () => {
    const result = buildMobileWorkspaces({
      worktrees: [worktree({ worktreeId: 'wt-1' })],
      sessions: [
        session({ sessionId: 'known', workspaceId: 'wt-1' }),
        session({ sessionId: 'orphan', workspaceId: 'folder-9', latestPrompt: 'Folder task' })
      ]
    })

    const other = result.find((group) => group.workspaceId === '__mobile_other_workspaces__')
    expect(other?.name).toBe('Other tasks')
    expect(other?.sessions.map((entry) => entry.sessionId)).toEqual(['orphan'])
  })

  it('uses the conversation name before the latest prompt for the card title', () => {
    expect(
      mobileSessionTitle(
        session({ conversationName: 'Tunnel cleanup', latestPrompt: 'A much longer prompt' })
      )
    ).toBe('Tunnel cleanup')
    expect(mobileSessionTitle(session({ latestPrompt: '  line one\nline two  ' }))).toBe(
      'line one line two'
    )
  })
})

describe('mobile session helpers', () => {
  it('maps host statuses to the three mobile states', () => {
    expect(mobileSessionStatus('attention')).toBe('attention')
    expect(mobileSessionStatus('working')).toBe('working')
    expect(mobileSessionStatus('idle')).toBe('idle')
    expect(mobileSessionStatus(null)).toBe('idle')
  })

  it('formats short relative times without locale-dependent output', () => {
    const now = 10_000_000_000
    expect(formatMobileRelativeTime(now - 10_000, now)).toBe('now')
    expect(formatMobileRelativeTime(now - 5 * 60_000, now)).toBe('5m')
    expect(formatMobileRelativeTime(now - 3 * 3_600_000, now)).toBe('3h')
    expect(formatMobileRelativeTime(now - 2 * 86_400_000, now)).toBe('2d')
    expect(formatMobileRelativeTime(0, now)).toBe('')
  })

  it('labels agents for the compact badge', () => {
    expect(mobileAgentLabel('codex')).toBe('Codex')
    expect(mobileAgentLabel('opencode')).toBe('OpenCode')
    expect(mobileAgentLabel('pi')).toBe('Pi')
  })
})
