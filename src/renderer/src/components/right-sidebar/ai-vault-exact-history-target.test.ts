import { expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { exactConversationHistorySessions } from './ai-vault-exact-history-target'

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'local:claude:target',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'target',
    title: 'Target session',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: '/sessions/target.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 0,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    ...overrides
  }
}

it('keeps the source host and agent in an exact conversation history target', () => {
  const target = session()

  expect(
    exactConversationHistorySessions(
      [
        target,
        session({ id: 'local:codex:target', agent: 'codex' }),
        session({ id: 'ssh:box:claude:target', executionHostId: 'ssh:box' }),
        session({ id: 'local:claude:other', sessionId: 'other' })
      ],
      { executionHostId: 'local', agent: 'claude', sessionId: 'target', scope: 'all' }
    )
  ).toEqual([target])
})
