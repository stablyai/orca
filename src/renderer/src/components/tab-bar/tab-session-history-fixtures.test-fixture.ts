import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeRepo, makeTerminalTab, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { makeAgentStatusEntry } from '@/runtime/sync-runtime-graph-test-harness'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { TabSessionHistorySubject } from './tab-session-history-switch'

export const WORKTREE_ID = 'repo-1::/repo/wt'

export function row(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'row-1',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'claude-session-1',
    title: 'Fix the build',
    cwd: '/repo/wt',
    branch: 'main',
    model: null,
    filePath: '/home/.claude/projects/repo/claude-session-1.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-10-08T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 10,
    previewMessages: [{ role: 'user', text: 'Fix the build', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume claude-session-1',
    subagent: null,
    ...overrides
  }
}

const SIBLING_ID = 'repo-1::/repo/sibling'

export function makeState(
  agentStatusByPaneKey: AppState['agentStatusByPaneKey'] = {},
  repo: Partial<ReturnType<typeof makeRepo>> = {}
): AppState {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    agentStatusByPaneKey,
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE_ID,
    repos: [{ ...makeRepo(), ...repo }],
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTerminalTab('term-1', WORKTREE_ID, 'claude')]
    },
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(WORKTREE_ID, 'wt', { path: '/repo/wt' }),
        makeWorktree(SIBLING_ID, 'sibling', { path: '/repo/sibling' })
      ]
    }
  })
  return useAppStore.getState()
}

export const PANEL_REQUEST = {
  scopePaths: ['/repo/wt'],
  executionHostScope: 'local',
  sessionLimit: 250
} as const

export const liveClaudeEntry = {
  'term-1:leaf-1': makeAgentStatusEntry({
    agentType: 'claude',
    paneKey: 'term-1:leaf-1',
    tabId: 'term-1',
    worktreeId: WORKTREE_ID,
    providerSession: { key: 'session_id', id: 'claude-session-1' }
  })
}

export const chatSubject: TabSessionHistorySubject = {
  kind: 'chat',
  sessionId: 'orca-chat-1',
  workspaceId: WORKTREE_ID,
  request: PANEL_REQUEST
}

export const cliSubject: TabSessionHistorySubject = {
  kind: 'cli',
  agent: 'claude',
  providerSessionId: 'claude-session-1',
  workspaceId: WORKTREE_ID,
  request: PANEL_REQUEST
}
