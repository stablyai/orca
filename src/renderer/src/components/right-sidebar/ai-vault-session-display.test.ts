import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  latestSessionConversationTurn,
  recentSessionConversationTurns,
  sessionPreviewSearchText
} from './ai-vault-session-display'

const baseSession: AiVaultSession = {
  id: 'codex:1',
  agent: 'codex',
  sessionId: 'session-1',
  title: 'Fix the flaky golden tests',
  cwd: '/Users/ada/repo/app',
  branch: 'fix/golden',
  model: 'gpt-5.5',
  filePath: '/Users/ada/.codex/sessions/session-1.jsonl',
  codexHome: null,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-01T10:10:00.000Z',
  modifiedAt: '2026-05-01T10:10:00.000Z',
  messageCount: 4,
  totalTokens: 1200,
  previewMessages: [
    { role: 'user', text: 'Please fix the flaky golden tests', timestamp: null },
    { role: 'tool', text: 'pnpm test failed', timestamp: null },
    { role: 'assistant', text: 'I updated the fixture ordering', timestamp: null },
    { role: 'system', text: 'hidden runtime bookkeeping', timestamp: null }
  ],
  resumeCommand: "cd '/Users/ada/repo/app' && codex resume 'session-1'"
}

describe('ai vault session display', () => {
  it('uses the latest user or assistant turn for the collapsed row preview', () => {
    expect(latestSessionConversationTurn(baseSession)).toEqual({
      role: 'assistant',
      text: 'I updated the fixture ordering',
      timestamp: null
    })
  })

  it('keeps recent turns conversation-first and falls back when no conversation turns exist', () => {
    expect(recentSessionConversationTurns(baseSession, 2).map((turn) => turn.text)).toEqual([
      'Please fix the flaky golden tests',
      'I updated the fixture ordering'
    ])

    expect(
      recentSessionConversationTurns(
        {
          ...baseSession,
          previewMessages: [{ role: 'tool', text: 'tool-only transcript', timestamp: null }]
        },
        1
      )
    ).toEqual([{ role: 'tool', text: 'tool-only transcript', timestamp: null }])
  })

  it('builds search text from displayed preview messages', () => {
    expect(sessionPreviewSearchText(baseSession)).toContain('fixture ordering')
    expect(sessionPreviewSearchText(baseSession)).not.toContain('pnpm test failed')
    expect(sessionPreviewSearchText(baseSession)).not.toContain('hidden runtime bookkeeping')
  })

  it('searches fallback tool text when no conversation turns exist', () => {
    expect(
      sessionPreviewSearchText({
        ...baseSession,
        previewMessages: [{ role: 'tool', text: 'tool-only transcript', timestamp: null }]
      })
    ).toBe('tool-only transcript')
  })
})
