import { describe, expect, it } from 'vitest'
import {
  agentSearchSummaryMatches,
  buildAgentSearchSummary,
  normalizeAgentSearchQuery,
  truncateToUtf8ByteBudget
} from './agent-search-query'
import { AGENT_SEARCH_QUERY_MAX_BYTES, utf8ByteLength } from './custom-tui-agent-fields'

const GRINNING = '\u{1F600}' // 😀 — 4 UTF-8 bytes, 2 UTF-16 code units

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

describe('normalizeAgentSearchQuery', () => {
  it('folds NFKC, collapses White_Space, trims, and lowercases (en-US)', () => {
    // Fullwidth Ｃ → NFKC C → lowercase c; whitespace run collapses; ends trim.
    expect(normalizeAgentSearchQuery('  Ｃ O D E X  ')).toBe('c o d e x')
    expect(normalizeAgentSearchQuery('MyCodex')).toBe('mycodex')
  })

  it('caps at the 2 KiB byte budget', () => {
    const result = normalizeAgentSearchQuery('a'.repeat(5000))
    expect(utf8ByteLength(result)).toBe(AGENT_SEARCH_QUERY_MAX_BYTES)
  })

  it('truncates a run of multi-byte emoji on whole code points', () => {
    // 520 emoji = 2080 bytes > 2048; must land on 512 whole emoji = 2048 bytes.
    const result = normalizeAgentSearchQuery(GRINNING.repeat(520))
    expect(utf8ByteLength(result)).toBe(2048)
    expect([...result]).toHaveLength(512)
    expect([...result].every((codePoint) => codePoint === GRINNING)).toBe(true)
    expect(hasLoneSurrogate(result)).toBe(false)
  })

  it('stops at a code-point boundary rather than splitting to fill the last bytes', () => {
    // 2002 ASCII (2002 bytes) leaves a 46-byte remainder under the 2048 cap;
    // a 4-byte emoji packs 11× (44 bytes) and the 12th would overflow, so the
    // result is 2046 bytes — proving it never splits an emoji to hit 2048 exactly.
    const result = normalizeAgentSearchQuery(`${'a'.repeat(2002)}${GRINNING.repeat(20)}`)
    expect(utf8ByteLength(result)).toBe(2046)
    expect(result.endsWith(GRINNING)).toBe(true)
    expect(hasLoneSurrogate(result)).toBe(false)
  })
})

describe('truncateToUtf8ByteBudget', () => {
  it('returns the input unchanged when already within budget', () => {
    expect(truncateToUtf8ByteBudget('codex', 2048)).toBe('codex')
  })

  it('never emits a lone surrogate at the boundary', () => {
    // Budget lands one byte short of a full emoji; the emoji is dropped whole.
    const result = truncateToUtf8ByteBudget(`ab${GRINNING}`, 3)
    expect(result).toBe('ab')
    expect(hasLoneSurrogate(result)).toBe(false)
  })
})

describe('buildAgentSearchSummary', () => {
  it('combines label, base name, and command summary into one normalized string', () => {
    const summary = buildAgentSearchSummary({
      label: 'My Codex',
      baseName: 'Codex',
      commandSummary: 'codex --yolo'
    })
    const matches = (raw: string): boolean =>
      agentSearchSummaryMatches(summary, normalizeAgentSearchQuery(raw))
    expect(matches('my codex')).toBe(true) // label
    expect(matches('Codex')).toBe(true) // base name, case-insensitive
    expect(matches('YOLO')).toBe(true) // secondary command summary
    expect(matches('nonesuch')).toBe(false)
  })

  it('omits an absent command summary without leaving a stray separator', () => {
    const summary = buildAgentSearchSummary({ label: 'Plain', baseName: 'Gemini' })
    expect(summary).toBe('plain gemini')
  })

  it('bounds a corrupt oversize field to the byte budget', () => {
    const summary = buildAgentSearchSummary({ label: 'x'.repeat(5000), baseName: 'codex' })
    expect(utf8ByteLength(summary)).toBeLessThanOrEqual(AGENT_SEARCH_QUERY_MAX_BYTES)
  })
})

describe('agentSearchSummaryMatches', () => {
  it('treats an empty query as matching every row', () => {
    expect(agentSearchSummaryMatches('anything', '')).toBe(true)
  })
})
