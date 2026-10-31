import { describe, expect, it } from 'vitest'
import { projectConversations, projectConversationTitle } from './project-conversation-list'
import { conversationPreferenceKey } from './conversation-navigation-preferences'
import type { AiVaultSession } from './ai-vault-types'
const row = (id: string, date: string): AiVaultSession => ({
  id,
  sessionId: id,
  executionHostId: 'local',
  agent: 'claude',
  title: 'Claude Chat',
  cwd: '/notes',
  branch: null,
  model: null,
  filePath: '/log',
  codexHome: null,
  createdAt: date,
  updatedAt: date,
  modifiedAt: date,
  messageCount: 2,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: '',
  subagent: null
})
describe('project conversation navigation', () => {
  it('puts pinned chats before recency and restores archived chats without changing their identity', () => {
    const old = row('old', '2026-10-01')
    const recent = row('recent', '2026-10-26')
    const archived = row('archived', '2026-10-25')
    const preferences = {
      revision: 1,
      entries: {
        [conversationPreferenceKey(old)]: { pinned: true },
        [conversationPreferenceKey(archived)]: { archived: true }
      }
    }
    expect(projectConversations([recent, archived, old], preferences).map((s) => s.id)).toEqual([
      'old',
      'recent'
    ])
    expect(projectConversations([recent, archived, old], preferences, true)).toEqual([archived])
  })
  it('omits only proven empty records, preserving unknown or recoverable conversations', () => {
    const unknown = row('unknown', '2026-10-26')
    const empty = { ...row('empty', '2026-10-25'), conversationContent: 'empty' as const }
    expect(projectConversations([empty, unknown], { revision: 0, entries: {} })).toEqual([unknown])
  })
  it('uses a user prompt for generic names and respects actual saved titles', () => {
    const session = {
      ...row('chat', '2026-10-26'),
      previewMessages: [
        { role: 'user' as const, text: 'Fix reader pagination alignment', timestamp: null }
      ]
    }
    expect(projectConversationTitle(session)).toBe('Fix reader pagination alignment')
    expect(projectConversationTitle(session, 'Reader pagination')).toBe('Reader pagination')
  })

  it('replaces injected command titles from older hosts with a human prompt', () => {
    const caveat = '<local-command-caveat>Local command output follows</local-command-caveat>'
    const session = {
      ...row('chat', '2026-10-26'),
      title: caveat,
      firstUserPrompt: caveat,
      previewMessages: [
        { role: 'user' as const, text: caveat, timestamp: null },
        { role: 'user' as const, text: 'Fix reader pagination alignment', timestamp: null }
      ]
    }
    expect(projectConversationTitle(session)).toBe('Fix reader pagination alignment')
    expect(projectConversationTitle({ ...session, previewMessages: [] })).toBe('')
    expect(projectConversationTitle(session, '<my-card> rendering')).toBe('<my-card> rendering')
  })

  it('replaces scanner-generated identifier labels when a human prompt is available', () => {
    const session = {
      ...row('019f7a2c-1234', '2026-10-26'),
      title: 'Claude 019f7a2c',
      firstUserPrompt: 'Investigate the intermittent deployment failure'
    }
    expect(projectConversationTitle(session)).toBe(
      'Investigate the intermittent deployment failure'
    )
  })
})
