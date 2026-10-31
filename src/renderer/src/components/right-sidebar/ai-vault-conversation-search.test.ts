import { describe, expect, it } from 'vitest'
import { mergeAiVaultConversationSearch } from './ai-vault-conversation-search'
import { conversationSessions } from '../sidebar/ProjectConversationList.test-fixture'
import type { AiVaultSessionFilterState } from '../../../../shared/ai-vault-session-filters'
const base = {
  ...conversationSessions[0]!,
  source: 'structured-record' as const,
  title: 'Saved chat',
  firstUserPrompt: 'A bounded journal prompt contains a distinctive marker',
  structuredSession: { sessionId: 'durable', workspaceId: 'folder:notes' }
}
const filters: AiVaultSessionFilterState = {
  query: 'distinctive',
  agents: ['claude'],
  scope: 'all',
  sort: 'updated',
  activeWorktreePaths: [],
  hideEmptySessions: true,
  preserveStructuredSessions: true
}

describe('primary project conversation search', () => {
  it('finds a durable journal prompt without any provider index result', () => {
    expect(mergeAiVaultConversationSearch([], [base], filters)).toEqual({
      sessions: [base],
      hasMetadataMatches: true
    })
  })
  it('retains deep indexed hits and deduplicates native handles by exact host/conversation identity', () => {
    const indexed = { ...base, id: 'index', sessionId: 'new-provider-id', title: 'Provider title' }
    const remote = { ...base, id: 'remote', executionHostId: 'runtime:remote' as const }
    const result = mergeAiVaultConversationSearch([indexed, remote], [base], filters)
    expect(result.sessions).toEqual([base, remote])
    expect(
      mergeAiVaultConversationSearch([indexed], [], { ...filters, query: 'deep output only' })
        .sessions
    ).toEqual([indexed])
  })
  it('preserves repo/path operators and treats unknown legacy query syntax as existing literal terms', () => {
    const input = { ...base, firstUserPrompt: 'legacy:marker', cwd: '/notes/api' }
    expect(
      mergeAiVaultConversationSearch([], [input], {
        ...filters,
        query: 'legacy:marker path:/notes'
      }).sessions
    ).toEqual([input])
    expect(
      mergeAiVaultConversationSearch([], [input], {
        ...filters,
        query: 'legacy:marker path:/other'
      }).sessions
    ).toEqual([])
  })
})
