import { describe, expect, it } from 'vitest'
import {
  AI_VAULT_TRANSCRIPT_SEARCH_MAX_REQUESTS,
  AI_VAULT_TRANSCRIPT_SEARCH_MAX_SNIPPET_LENGTH,
  AI_VAULT_TRANSCRIPT_SEARCH_SNIPPET_LEAD_CHARS,
  aiVaultTranscriptSearchRequestKey,
  extractTranscriptSearchSnippet,
  isAiVaultTranscriptSearchQueryTooLarge,
  normalizeAiVaultTranscriptSearchArgs
} from './ai-vault-transcript-search'

// Why: keep a raw control byte out of the source file itself.
const CONTROL_BYTE = String.fromCharCode(1)

describe('normalizeAiVaultTranscriptSearchArgs', () => {
  it('trims the query and drops duplicate requests by (agent, filePath)', () => {
    const normalized = normalizeAiVaultTranscriptSearchArgs({
      query: '  flash attention  ',
      requests: [
        { agent: 'claude', filePath: '/t/a.jsonl', sessionId: 's1' },
        { agent: 'claude', filePath: '/t/a.jsonl' },
        { agent: 'codex', filePath: '/t/b.jsonl', sessionId: 's2' }
      ]
    })
    expect(normalized.query).toBe('flash attention')
    expect(normalized.requests).toEqual([
      { agent: 'claude', filePath: '/t/a.jsonl', sessionId: 's1' },
      { agent: 'codex', filePath: '/t/b.jsonl', sessionId: 's2' }
    ])
    expect(normalized.truncated).toBe(false)
  })

  it('rejects queries shorter than the minimum length', () => {
    const normalized = normalizeAiVaultTranscriptSearchArgs({
      query: ' a ',
      requests: [{ agent: 'claude', filePath: '/t/a.jsonl' }]
    })
    expect(normalized.query).toBe('')
    expect(normalized.requests).toEqual([])
  })

  it('drops requests with missing or oversized paths but keeps valid ones', () => {
    const normalized = normalizeAiVaultTranscriptSearchArgs({
      query: 'flash attention',
      requests: [
        { agent: 'claude', filePath: '   ' },
        { agent: 'claude', filePath: `/t/${'x'.repeat(33_000)}.jsonl` },
        { agent: 'codex', filePath: '/t/b.jsonl' }
      ]
    })
    expect(normalized.requests).toEqual([{ agent: 'codex', filePath: '/t/b.jsonl' }])
    expect(normalized.truncated).toBe(false)
  })

  it('flags truncation when the request count exceeds the bound', () => {
    const requests = Array.from(
      { length: AI_VAULT_TRANSCRIPT_SEARCH_MAX_REQUESTS + 5 },
      (_, i) => ({
        agent: 'claude' as const,
        filePath: `/t/${i}.jsonl`
      })
    )
    const normalized = normalizeAiVaultTranscriptSearchArgs({ query: 'flash attention', requests })
    expect(normalized.requests).toHaveLength(AI_VAULT_TRANSCRIPT_SEARCH_MAX_REQUESTS)
    expect(normalized.truncated).toBe(true)
  })
})

describe('isAiVaultTranscriptSearchQueryTooLarge', () => {
  it('accepts a normal query and rejects an oversized one', () => {
    expect(isAiVaultTranscriptSearchQueryTooLarge('flash attention')).toBe(false)
    expect(isAiVaultTranscriptSearchQueryTooLarge('x'.repeat(3 * 1024))).toBe(true)
  })
})

describe('extractTranscriptSearchSnippet', () => {
  it('strips control bytes and collapses escaped newlines', () => {
    const line = `{"role":"user","text":"please fix${CONTROL_BYTE}the bug\\nwhere it crashes on start"}`
    const snippet = extractTranscriptSearchSnippet(line, 'crashes')
    expect(snippet).not.toContain(CONTROL_BYTE)
    expect(snippet).toContain('crashes on start')
    expect(snippet).toContain('please fix the bug')
  })

  it('returns a short line untouched', () => {
    expect(extractTranscriptSearchSnippet('fix the flash attention kernel', 'flash')).toBe(
      'fix the flash attention kernel'
    )
  })

  it('windows long lines around the first hit', () => {
    const filler = 'lorem ipsum '.repeat(200)
    const line = `${filler}the needle is here and the tail continues ${filler}`
    const snippet = extractTranscriptSearchSnippet(line, 'needle', 60)
    expect(snippet.length).toBeLessThanOrEqual(62)
    expect(snippet).toContain('needle')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('prefix-truncates when the hit is beyond the first window', () => {
    const filler = 'a'.repeat(500)
    const snippet = extractTranscriptSearchSnippet(`${filler} needle tail`, 'needle', 40)
    expect(snippet).toContain('needle')
    expect(snippet.startsWith('…')).toBe(true)
  })

  it('matches the query case-insensitively when centering the window', () => {
    const snippet = extractTranscriptSearchSnippet(
      `${'x'.repeat(300)} Flash Attention tail`,
      'flash attention',
      30
    )
    expect(snippet.toLowerCase()).toContain('flash attention')
  })

  it('keeps the hit near the front so a narrow row never truncates it away', () => {
    const line = `${'long filler '.repeat(200)}the needle is buried deep in the message`
    const snippet = extractTranscriptSearchSnippet(line, 'needle')
    const hit = snippet.toLowerCase().indexOf('needle')
    expect(hit).toBeGreaterThanOrEqual(0)
    expect(hit).toBeLessThan(
      AI_VAULT_TRANSCRIPT_SEARCH_SNIPPET_LEAD_CHARS + AI_VAULT_TRANSCRIPT_SEARCH_MAX_SNIPPET_LENGTH
    )
    // The match sits just past the short lead, well inside the visible window.
    expect(hit).toBeLessThanOrEqual(AI_VAULT_TRANSCRIPT_SEARCH_SNIPPET_LEAD_CHARS + 8)
    expect(snippet.slice(0, hit)).toContain('…')
  })
})

describe('aiVaultTranscriptSearchRequestKey', () => {
  it('separates agents and shares one key for equal requests', () => {
    expect(aiVaultTranscriptSearchRequestKey({ agent: 'claude', filePath: '/a.jsonl' })).not.toBe(
      aiVaultTranscriptSearchRequestKey({ agent: 'codex', filePath: '/a.jsonl' })
    )
    expect(aiVaultTranscriptSearchRequestKey({ agent: 'claude', filePath: '/a.jsonl' })).toBe(
      aiVaultTranscriptSearchRequestKey({ agent: 'claude', filePath: '/a.jsonl' })
    )
  })
})
