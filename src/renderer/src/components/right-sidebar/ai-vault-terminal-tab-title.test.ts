import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { OriginalPaneState } from './ai-vault-original-pane'

vi.mock('./ai-vault-original-pane', () => ({
  findOriginalAiVaultSessionPane: (_state: unknown, session: AiVaultSession) =>
    session.sessionId === 'unmatched'
      ? null
      : { paneKey: 'tab-1:leaf', worktreeId: 'w1', tabId: 'tab-1', leafId: 'leaf' },
  resolveOriginalPaneTarget: () => ({
    paneKey: 'tab-1:leaf',
    worktreeId: 'w1',
    tabId: 'tab-1',
    leafId: 'leaf'
  })
}))

import {
  openRenamedTabSessionRefs,
  withTerminalTabTitleMatches
} from './ai-vault-terminal-tab-title'

function session(sessionId: string, updatedAt: string | null = null): AiVaultSession {
  return {
    id: `local:${sessionId}`,
    executionHostId: 'local',
    agent: 'claude',
    sessionId,
    title: 'Original prompt',
    cwd: '/folder',
    branch: null,
    model: null,
    filePath: `/sessions/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt,
    modifiedAt: '2026-10-06T00:00:00Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
}

const state: OriginalPaneState = {
  agentStatusByPaneKey: {},
  retainedAgentsByPaneKey: {},
  sleepingAgentSessionsByPaneKey: {},
  terminalLayoutsByTabId: {},
  tabsByWorktree: {
    w1: [
      {
        id: 'tab-1',
        ptyId: null,
        worktreeId: 'w1',
        title: 'Terminal 1',
        customTitle: 'Billing Refactor',
        color: null,
        sortOrder: 0,
        createdAt: 0
      }
    ]
  }
}

describe('withTerminalTabTitleMatches', () => {
  it('adds history rows whose renamed tab matches every term', () => {
    const history = [session('a'), session('unmatched')]
    const result = withTerminalTabTitleMatches([], history, 'billing refactor', 'relevance', state)
    expect(result.map((row) => row.sessionId)).toEqual(['a'])
  })

  it('keeps host hits and does not duplicate them', () => {
    const hit = session('a')
    expect(
      withTerminalTabTitleMatches([hit], [session('a')], 'billing', 'relevance', state)
    ).toEqual([hit])
  })

  it('does not duplicate a path-redacted hit whose id differs from its history row', () => {
    const hit = { ...session('a'), id: 'local:claude:a:', filePath: '' }
    expect(
      withTerminalTabTitleMatches([hit], [session('a')], 'billing', 'relevance', state)
    ).toEqual([hit])
  })

  it('treats repo: and path: operators as filters, not title terms', () => {
    const result = withTerminalTabTitleMatches(
      [],
      [session('a')],
      'billing repo:app',
      'relevance',
      state
    )
    expect(result.map((row) => row.sessionId)).toEqual(['a'])
  })

  it('ignores queries that do not match the tab title', () => {
    expect(withTerminalTabTitleMatches([], [session('a')], 'payments', 'relevance', state)).toEqual(
      []
    )
  })

  it('merges title matches by recency when sorting newest first', () => {
    const older = { ...session('older', '2026-10-01T00:00:00Z'), title: 'x' }
    const newer = session('newer', '2026-10-20T00:00:00Z')
    const hit = { ...session('hit', '2026-10-10T00:00:00Z'), id: 'local:hit' }
    const hitUnmatched = { ...hit, sessionId: 'unmatched' }
    const result = withTerminalTabTitleMatches(
      [older, hitUnmatched],
      [newer],
      'billing',
      'newest',
      state
    )
    expect(result.map((row) => row.sessionId)).toEqual(['newer', 'unmatched', 'older'])
  })
})

describe('openRenamedTabSessionRefs', () => {
  it('lists provider sessions in open tabs whose rename matches, even when history lacks them', () => {
    const paneKey = 'tab-1:leaf'
    const refs = openRenamedTabSessionRefs(
      {
        ...state,
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            tabId: 'tab-1',
            worktreeId: 'w1',
            agentType: 'claude',
            providerSession: { key: 'session_id', id: 'old-session' },
            state: 'done',
            prompt: '',
            updatedAt: 0,
            stateStartedAt: 0,
            stateHistory: []
          }
        }
      },
      'billing'
    )
    expect(refs).toEqual([{ agent: 'claude', sessionId: 'old-session', worktreeId: 'w1' }])
  })
})
