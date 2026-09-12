import { describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from './ai-vault-types'
import { isPathInsideOrEqual } from './cross-platform-path'
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

describe('Agent Session History scope truncation', () => {
  it('normalizes scope roots and candidate cwd once per truncation pass', () => {
    const loaded = result(
      Array.from({ length: 1000 }, (_, i) => session(`id-${i}`, `/other/${i}`, i))
    )
    const scopes = Array.from({ length: 100 }, (_, i) => `/repo/${i}`)
    const normalize = vi.spyOn(String.prototype, 'normalize')
    let selected: AiVaultListResult
    try {
      selected = truncateAiVaultListResult(loaded, 10, scopes)
      expect(normalize.mock.calls.length).toBeLessThanOrEqual(1100)
    } finally {
      normalize.mockRestore()
    }
    expect(selected.sessions).toEqual(loaded.sessions.slice(0, 10))
  })

  it('selects scoped sessions identically to the pre-hoist path predicate', () => {
    const cases = [
      ['C:\\Users\\Ada\\repo', 'c:/users/ada/repo/app'],
      ['C:/Users/Ada/repo/', 'C:\\Users\\Ada\\repo'],
      ['C:\\Users\\Ada\\repo', 'C:\\Users\\Ada\\repo-other'],
      ['//wsl.localhost/Ubuntu/home/Ada/Repo', '//wsl$/Ubuntu/home/Ada/Repo/App'],
      ['//wsl.localhost/Ubuntu/home/ada/repo', '//wsl.localhost/Debian/home/ada/repo'],
      ['/Users/ada/repo', '/Users/ada/repo//app/'],
      ['/Users/ada/repo', '/Users/ada/repository'],
      ['/', '/anywhere']
    ]
    for (const [scope, cwd] of cases) {
      const loaded = result([session('scoped', cwd!, 0)])
      const selected = truncateAiVaultListResult(loaded, 0, [scope!])
      expect({ scope, cwd, kept: selected.sessions.length === 1 }).toEqual({
        scope,
        cwd,
        kept: isPathInsideOrEqual(scope!, cwd!)
      })
    }
  })
})
