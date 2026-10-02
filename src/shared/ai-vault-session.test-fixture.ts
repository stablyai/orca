import type { AiVaultSession } from './ai-vault-types'

export function aiVaultSessionFixture(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  const at = new Date(1740000000000).toISOString()
  return {
    id: 'fixture',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'fixture',
    title: 'fixture session',
    cwd: '/fixture',
    branch: null,
    model: null,
    filePath: 'synthetic-transcript',
    codexHome: null,
    createdAt: at,
    updatedAt: at,
    modifiedAt: at,
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
