import { describe, expect, it } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from './ai-vault-types'
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

describe('Agent Session History depth', () => {
  it('keeps every scoped session and the newest out-of-scope ones when truncating', () => {
    const loaded = result([
      session('global-1', '/other', 6),
      session('global-2', '/other', 5),
      session('global-3', '/other', 4),
      session('scoped-1', '/repo/app', 3),
      session('scoped-2', '/repo/lib', 2),
      session('scoped-3', '/repo/old', 1)
    ])

    expect(truncateAiVaultListResult(loaded, 2, ['/repo']).sessions.map(({ id }) => id)).toEqual([
      'global-1',
      'global-2',
      'scoped-1',
      'scoped-2',
      'scoped-3'
    ])
    expect(truncateAiVaultListResult(loaded, 2).sessions.map(({ id }) => id)).toEqual([
      'global-1',
      'global-2'
    ])
    expect(truncateAiVaultListResult(loaded, 'unlimited')).toBe(loaded)
  })
})

describe('truncateAiVaultListResult symlinked scope', () => {
  it('keeps a session whose host alias is in scope when depth drops out-of-scope rows', () => {
    const linked = { ...session('linked', '/data/src/api', 1), cwdAliases: ['/home/me/work/api'] }
    const other = session('other', '/elsewhere', 2)

    const truncated = truncateAiVaultListResult(result([other, linked]), 0, ['/home/me/work/api'])

    expect(truncated.sessions.map((entry) => entry.id)).toEqual(['linked'])
  })
})
