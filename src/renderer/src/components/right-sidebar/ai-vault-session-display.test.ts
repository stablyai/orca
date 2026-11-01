import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  sessionDetailConversationTurns,
  sessionPromptPreview,
  sessionPreviewSearchText
} from './ai-vault-session-display'

const baseSession: AiVaultSession = {
  id: 'codex:1',
  executionHostId: 'local',
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
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: "cd '/Users/ada/repo/app' && codex resume 'session-1'",
  subagent: null
}

describe('ai vault session display', () => {
  it('builds search text from displayed preview messages', () => {
    expect(sessionPreviewSearchText(baseSession)).toContain('fixture ordering')
    expect(sessionPreviewSearchText(baseSession)).not.toContain('pnpm test failed')
    expect(sessionPreviewSearchText(baseSession)).not.toContain('hidden runtime bookkeeping')
  })

  it('drops title-matching turns and adjacent duplicates from detail turns', () => {
    const session: AiVaultSession = {
      ...baseSession,
      title: 'Fix the flaky golden tests',
      previewMessages: [
        { role: 'user', text: 'Fix the flaky golden tests', timestamp: null },
        { role: 'assistant', text: 'I updated the fixture ordering', timestamp: null },
        { role: 'assistant', text: 'I updated the fixture ordering', timestamp: null },
        { role: 'assistant', text: 'Added a regression test', timestamp: null }
      ]
    }

    expect(sessionDetailConversationTurns(session, 3).map((turn) => turn.text)).toEqual([
      'I updated the fixture ordering',
      'Added a regression test'
    ])
  })

  it('prefers the stored firstUserPrompt over sliding preview turns', () => {
    expect(
      sessionPromptPreview({
        ...baseSession,
        firstUserPrompt: 'Original long first prompt that scrolled out of preview',
        previewMessages: [
          { role: 'user', text: 'Later user turn still in the preview window', timestamp: null },
          { role: 'assistant', text: 'Later reply', timestamp: null }
        ]
      })
    ).toEqual({
      text: 'Original long first prompt that scrolled out of preview',
      source: 'first-user-prompt'
    })
  })

  it('marks list-scan fallback text as a preview-window prompt', () => {
    expect(sessionPromptPreview(baseSession)).toEqual({
      text: 'Please fix the flaky golden tests',
      source: 'preview-window'
    })
    expect(
      sessionPromptPreview({
        ...baseSession,
        previewMessages: [{ role: 'assistant', text: 'Only agent text', timestamp: null }]
      })
    ).toBeNull()
  })

  it('keeps a truncated sliding-window fallback available as a recent prompt', () => {
    expect(
      sessionPromptPreview({
        ...baseSession,
        previewMessagesTruncated: true,
        previewMessages: [
          { role: 'user', text: 'Later user turn still in the preview window', timestamp: null },
          { role: 'assistant', text: 'Later reply', timestamp: null }
        ]
      })
    ).toEqual({
      text: 'Later user turn still in the preview window',
      source: 'preview-window'
    })
  })

  it('still prefers a stored firstUserPrompt when the window has truncated', () => {
    expect(
      sessionPromptPreview({
        ...baseSession,
        previewMessagesTruncated: true,
        firstUserPrompt: 'Original long first prompt that scrolled out of preview',
        previewMessages: [
          { role: 'user', text: 'Later user turn still in the preview window', timestamp: null }
        ]
      })
    ).toEqual({
      text: 'Original long first prompt that scrolled out of preview',
      source: 'first-user-prompt'
    })
  })
})
