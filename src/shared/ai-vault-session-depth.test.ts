import { describe, expect, it } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from './ai-vault-types'
import {
  aiVaultScanLimit,
  aiVaultSessionDepthCovers,
  requestedAiVaultSessionDepth,
  truncateAiVaultListResult
} from './ai-vault-session-depth'

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
  it('recognizes which loaded depths cover a request', () => {
    expect(aiVaultSessionDepthCovers(250, 250)).toBe(true)
    expect(aiVaultSessionDepthCovers(1000, 250)).toBe(true)
    expect(aiVaultSessionDepthCovers(250, 500)).toBe(false)
    expect(aiVaultSessionDepthCovers(1000, 'unlimited')).toBe(false)
    expect(aiVaultSessionDepthCovers('unlimited', 1000)).toBe(true)
    expect(aiVaultSessionDepthCovers('unlimited', 'unlimited')).toBe(true)
  })

  it('normalizes default, finite, and unlimited requests', () => {
    expect(requestedAiVaultSessionDepth()).toBe(1000)
    expect(requestedAiVaultSessionDepth({ limit: 500 })).toBe(500)
    expect(requestedAiVaultSessionDepth({ limit: 500.75 })).toBe(500)
    expect(requestedAiVaultSessionDepth({ limit: 0 })).toBe(1000)
    expect(requestedAiVaultSessionDepth({ limit: -1 })).toBe(1000)
    expect(requestedAiVaultSessionDepth({ limit: Number.NaN })).toBe(1000)
    expect(requestedAiVaultSessionDepth({ limit: Number.POSITIVE_INFINITY })).toBe(1000)
    expect(requestedAiVaultSessionDepth({ limit: 500, unlimited: true })).toBe('unlimited')
  })

  it('resolves scan limits to a numeric bound', () => {
    expect(aiVaultScanLimit({ limit: 500 })).toBe(500)
    expect(aiVaultScanLimit({ limit: Number.POSITIVE_INFINITY })).toBe(1000)
    expect(aiVaultScanLimit({ unlimited: true })).toBe(Number.POSITIVE_INFINITY)
  })

  it('keeps the newest global and scoped sessions when truncating', () => {
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
      'scoped-2'
    ])
    expect(truncateAiVaultListResult(loaded, 'unlimited')).toBe(loaded)
  })
})
