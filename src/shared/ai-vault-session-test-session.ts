import type { AiVaultSession } from './ai-vault-types'

export function createAiVaultTestSession(
  overrides: Partial<AiVaultSession> & Pick<AiVaultSession, 'id'>
): AiVaultSession {
  return {
    executionHostId: 'local',
    agent: 'claude',
    sessionId: overrides.sessionId ?? overrides.id,
    title: 'Implement vault filters',
    cwd: '/Users/ada/repo/app',
    branch: 'feature/vault',
    model: 'claude-sonnet-4-5',
    filePath: '/Users/ada/.claude/projects/session-1.jsonl',
    codexHome: null,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:10:00.000Z',
    modifiedAt: '2026-05-01T10:10:00.000Z',
    messageCount: 4,
    totalTokens: 1200,
    previewMessages: [
      { role: 'user', text: 'add the scope tabs', timestamp: null },
      { role: 'assistant', text: 'done — added Workspace/Project/All', timestamp: null }
    ],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: "cd '/Users/ada/repo/app' && claude --resume 'session-1'",
    subagent: null,
    ...overrides
  }
}
