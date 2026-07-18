import { describe, expect, it, vi } from 'vitest'
import { decodeGrokTranscriptLine } from '../../../main/native-chat/transcript-line-decoders'
import { fetchGrokRateLimits } from '../../../main/rate-limits/grok-fetcher'
import {
  readGrokFixtureJson,
  readGrokFixtureJsonl,
  readGrokFixtureText
} from './load-grok-fixtures'

const netFetchMock = vi.hoisted(() => vi.fn())
const authState = vi.hoisted<{ file: string | null }>(() => ({ file: null }))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: string) => {
      if (String(path).endsWith('auth.json')) {
        return authState.file !== null
      }
      return actual.existsSync(path)
    },
    readFileSync: (path: string, encoding?: BufferEncoding) => {
      if (String(path).endsWith('auth.json')) {
        if (authState.file === null) {
          throw new Error('ENOENT')
        }
        return authState.file
      }
      return actual.readFileSync(path, encoding as BufferEncoding)
    }
  }
})

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

function freshAuthJson(): string {
  return JSON.stringify({
    'https://auth.x.ai::client': {
      key: 'access-token',
      user_id: 'user-1',
      email: 'dev@example.com',
      expires_at: '2099-01-01T00:00:00.000Z'
    }
  })
}

describe('Grok Build fixtures (compatibility goldens)', () => {
  it('loads billing weekly 42% golden into the rate-limit mapper', async () => {
    authState.file = freshAuthJson()
    netFetchMock.mockResolvedValueOnce(
      jsonResponse(readGrokFixtureJson('billing-weekly-42.json'))
    )
    const result = await fetchGrokRateLimits()
    expect(result.status).toBe('ok')
    expect(result.weekly?.usedPercent).toBe(42)
  })

  it('maps proto3-omitted weekly zero from the golden billing body', async () => {
    authState.file = freshAuthJson()
    netFetchMock.mockResolvedValueOnce(
      jsonResponse(readGrokFixtureJson('billing-weekly-zero-omitted.json'))
    )
    const result = await fetchGrokRateLimits()
    expect(result.status).toBe('ok')
    expect(result.weekly?.usedPercent).toBe(0)
  })

  it('falls back to monthly unified budget from the golden bodies', async () => {
    authState.file = freshAuthJson()
    // Credits view: ambiguous weekly period, no percent → default /billing monthly.
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(readGrokFixtureJson('billing-credits-no-weekly.json')))
      .mockResolvedValueOnce(jsonResponse(readGrokFixtureJson('billing-monthly-unified.json')))
    const result = await fetchGrokRateLimits()
    expect(result.status).toBe('ok')
    expect(result.weekly).toBeNull()
    expect(result.monthly?.usedPercent).toBeCloseTo((837 / 150000) * 100, 5)
  })

  it('decodes chat_history sample lines for native chat', () => {
    const lines = readGrokFixtureJsonl('chat_history-sample.jsonl')
    expect(lines.length).toBeGreaterThanOrEqual(3)

    const user = decodeGrokTranscriptLine(lines[0]!, 'row-0')
    expect(user?.role).toBe('user')
    expect(user?.blocks.some((b) => b.type === 'text' && b.text.includes('Fix the flaky'))).toBe(
      true
    )

    const assistant = decodeGrokTranscriptLine(lines[1]!, 'row-1')
    expect(assistant?.role).toBe('assistant')

    // Bootstrap / synthetic user rows are omitted from the conversation view.
    expect(decodeGrokTranscriptLine(lines[2]!, 'row-2')).toBeNull()
  })

  it('keeps Stop hook envelope fields Grok actually emits', () => {
    const envelope = readGrokFixtureJson<{
      hookEventName: string
      sessionId: string
      cwd: string
    }>('hook-stop-envelope.json')
    expect(envelope.hookEventName).toBe('Stop')
    expect(envelope.sessionId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(envelope.cwd.startsWith('/')).toBe(true)
  })

  it('documents encode_cwd_dirname goldens from open-source Grok Build', () => {
    const goldens = readGrokFixtureJson<{
      short: Array<{ cwd: string; encoded: string }>
      long: Array<{ cwd: string; encoded: string }>
    }>('encode-cwd-goldens.json')
    expect(goldens.short[0]?.encoded).toBe('%2Ftmp%2Fwork')
    expect(goldens.long.length).toBeGreaterThanOrEqual(4)
    // Long-form oracle: slug + 16 hex chars (blake3 prefix).
    for (const row of goldens.long) {
      expect(row.encoded).toMatch(/^[a-z0-9-]+-[0-9a-f]{16}$/)
    }
    // Fixture text must stay stable for CI lock.
    expect(readGrokFixtureText('encode-cwd-goldens.json')).toContain('main-branch-6aaeefdde2a621aa')
  })
})
