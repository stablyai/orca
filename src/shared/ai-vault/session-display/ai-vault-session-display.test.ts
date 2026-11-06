import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../contracts/ai-vault-types'
import { sessionDetailConversationTurns } from './ai-vault-session-display'

const baseSession: AiVaultSession = {
  id: 'codex:1',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'session-1',
  title: 'ARCHIVE-codex',
  cwd: '/Users/ada/repo/app',
  branch: null,
  model: null,
  filePath: '/Users/ada/.codex/sessions/session-1.jsonl',
  codexHome: null,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-01T10:10:00.000Z',
  modifiedAt: '2026-05-01T10:10:00.000Z',
  messageCount: 2,
  totalTokens: 100,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: "codex resume 'session-1'",
  subagent: null
}

describe('sessionDetailConversationTurns', () => {
  it('keeps an assistant reply that matches the title and drops the title-echo prompt', () => {
    const session: AiVaultSession = {
      ...baseSession,
      previewMessages: [
        { role: 'user', text: 'ARCHIVE-codex', timestamp: null },
        {
          role: 'user',
          text: 'Reply with exactly ARCHIVE-codex and nothing else.',
          timestamp: null
        },
        { role: 'assistant', text: 'ARCHIVE-codex', timestamp: null }
      ]
    }

    expect(sessionDetailConversationTurns(session, 3)).toEqual([
      { role: 'user', text: 'Reply with exactly ARCHIVE-codex and nothing else.', timestamp: null },
      { role: 'assistant', text: 'ARCHIVE-codex', timestamp: null }
    ])
  })
})
