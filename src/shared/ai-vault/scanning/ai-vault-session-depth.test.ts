import { describe, expect, it } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../contracts/ai-vault-types'
import { truncateAiVaultListResult } from './ai-vault-session-depth'

function session(id: string, cwd: string, index: number): AiVaultSession {
  const timestamp = new Date(Date.UTC(2026, 7, 2, 0, 0, index)).toISOString()
  return {
    id,
    executionHostId: 'local',
    agent: 'codex',
    sessionId: id,
    title: id,
    cwd,
    branch: null,
    model: null,
    filePath: `/sessions/${id}.jsonl`,
    codexHome: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    modifiedAt: timestamp,
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: id,
    subagent: null
  }
}

function result(sessions: AiVaultSession[]): AiVaultListResult {
  return { sessions, issues: [], scannedAt: '2026-08-02T00:00:00.000Z' }
}

describe('truncateAiVaultListResult symlinked scope', () => {
  it('keeps a session whose host alias is in scope when depth drops out-of-scope rows', () => {
    const linked = { ...session('linked', '/data/src/api', 1), cwdAliases: ['/home/me/work/api'] }
    const other = session('other', '/elsewhere', 2)

    const truncated = truncateAiVaultListResult(result([other, linked]), 0, ['/home/me/work/api'])

    expect(truncated.sessions.map((entry) => entry.id)).toEqual(['linked'])
  })
})
