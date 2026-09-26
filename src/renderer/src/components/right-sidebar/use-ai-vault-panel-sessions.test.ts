// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { useAiVaultPanelSessions } from './ai-vault-session-filters'

function makeSession(overrides: Partial<AiVaultSession>): AiVaultSession {
  return {
    id: 'codex:session-1',
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'session-1',
    title: 'Find the pane',
    cwd: '/repo/orca',
    branch: null,
    model: null,
    filePath: '/home/ada/.codex/session-1.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: '2026-06-24T10:00:00.000Z',
    modifiedAt: '2026-06-24T10:00:00.000Z',
    messageCount: 2,
    totalTokens: 42,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: "codex resume 'session-1'",
    subagent: null,
    ...overrides
  }
}

// Why: "1 of 502" counted every loaded session, most of them other workspaces'.
it('counts the scope before agent filters, not every loaded session', () => {
  const sessions = [
    makeSession({ id: 'codex:a', cwd: '/repo/orca' }),
    makeSession({ id: 'claude:b', agent: 'claude', cwd: '/repo/orca' }),
    makeSession({ id: 'codex:c', cwd: '/repo/other' })
  ]
  const { result } = renderHook(() =>
    useAiVaultPanelSessions(sessions, false, 'folder', {
      query: '',
      agents: ['codex'],
      scope: 'workspace',
      sort: 'updated',
      activeWorktreePaths: ['/repo/orca'],
      hideEmptySessions: false
    })
  )

  expect(result.current.filteredSessions.map((session) => session.id)).toEqual(['codex:a'])
  expect(result.current.scopedSessionCount).toBe(2)
})
