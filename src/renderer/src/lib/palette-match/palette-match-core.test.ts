import { describe, expect, it } from 'vitest'
import { matchPaletteDocument } from './match-document'
import { mapNormalizedRange, normalizePaletteText } from './normalized-text'
import { preparePaletteQuery, PALETTE_QUERY_MAX_TOKENS } from './palette-query'
import {
  buildPaletteDocument,
  comparePaletteDocumentRank,
  type PaletteDocumentInput
} from './palette-document'
import { segmentPaletteText } from './text-segments'
import { isWithinOnePaletteEdit } from './typo-distance'

function ready(query: string) {
  const prepared = preparePaletteQuery(query)
  if (prepared.state !== 'ready') {
    throw new Error(`expected ready query, got ${prepared.state}`)
  }
  return prepared
}

function run(input: PaletteDocumentInput, query: string) {
  const prepared = ready(query)
  return matchPaletteDocument({
    document: buildPaletteDocument(input),
    tokens: prepared.tokens,
    normalizedQuery: prepared.normalized
  })
}

const labelOnly = (text: string): PaletteDocumentInput => ({
  id: 'doc',
  visibleFields: [{ id: 'name', profile: 'structured-label', text }],
  evidence: []
})

describe('palette query preparation', () => {
  it('splits on whitespace only and keeps punctuation inside tokens', () => {
    expect(ready('orca/main 08-13 #123').tokens.map((token) => token.text)).toEqual([
      'orca/main',
      '08-13',
      '#123'
    ])
  })

  it('deduplicates repeated tokens', () => {
    expect(ready('scan scan daily').tokens.map((token) => token.text)).toEqual(['scan', 'daily'])
  })

  it('collapses whitespace runs so the whole-query tier still matches', () => {
    // Why: field text is always single-spaced, so an uncollapsed run could never satisfy
    // the whole-query equality tier and the exactly-named row silently lost its rank.
    expect(ready('scan  daily').normalized).toBe('scan daily')
    expect(run(labelOnly('scan daily'), 'scan  daily')?.rank.wholeQuery).toBe(
      run(labelOnly('scan daily'), 'scan daily')?.rank.wholeQuery
    )
  })

  it('treats emoji and symbols as content, not punctuation', () => {
    // Why: the palette input expands `:rocket:` into 🚀, so dropping symbol tokens made the
    // palette unable to match a query it produced itself.
    expect(ready('🚀 rocket').tokens[0]?.isPunctuationOnly).toBe(false)
    expect(run(labelOnly('🚀 rocket ship'), '🚀 rocket ship')).not.toBeNull()
    expect(run(labelOnly('a → b'), '→')).not.toBeNull()
    // A genuinely punctuation-only token stays rejected.
    expect(ready('--').tokens[0]?.isPunctuationOnly).toBe(true)
  })

  it('parses repo/branch per token', () => {
    expect(ready('orca/main').tokens[0].repoBranch).toEqual({ repo: 'orca', branch: 'main' })
    expect(ready('feature').tokens[0].repoBranch).toBeNull()
  })

  it('rejects more than the token limit', () => {
    const query = Array.from({ length: PALETTE_QUERY_MAX_TOKENS + 1 }, (_, i) => `t${i}`).join(' ')
    expect(preparePaletteQuery(query)).toEqual({ state: 'invalid', reason: 'too-many-tokens' })
  })

  it('rejects an oversized query', () => {
    expect(preparePaletteQuery('a'.repeat(3000))).toEqual({
      state: 'invalid',
      reason: 'too-large'
    })
  })

  it('splits a pasted tab- or newline-separated query into tokens', () => {
    expect(ready('scan\tdaily\n08-13').tokens.map((token) => token.text)).toEqual([
      'scan',
      'daily',
      '08-13'
    ])
  })

  it('marks every digit-bearing token identifier-like', () => {
    expect(ready('93334dc 1.4.182 run-184 docs').tokens.map((t) => t.isIdentifierLike)).toEqual([
      true,
      true,
      true,
      false
    ])
  })
})

describe('normalization and ranges', () => {
  it('uses identity mapping for length-preserving folds', () => {
    const text = normalizePaletteText('Jump Palette')
    expect(text.starts).toBeNull()
    expect(mapNormalizedRange(text, 5, 12)).toEqual({ start: 5, end: 12 })
  })

  it('maps decomposed accents back to the original range', () => {
    const text = normalizePaletteText('Café Deploy')
    const index = text.normalized.indexOf('deploy')
    expect(mapNormalizedRange(text, index, index + 6)).toEqual({ start: 6, end: 12 })
  })

  it('maps supplementary-plane characters back correctly', () => {
    const text = normalizePaletteText('🚀 Launch')
    const index = text.normalized.indexOf('launch')
    expect(text.original.slice(...Object.values(mapNormalizedRange(text, index, index + 6)))).toBe(
      'Launch'
    )
  })

  it('folds ASCII control whitespace without shifting offsets', () => {
    const text = normalizePaletteText('line one\nline two')
    expect(text.normalized).toBe('line one line two')
    expect(text.starts).toBeNull()
  })

  it('breaks atoms on a newline inside a multi-line comment', () => {
    const segments = segmentPaletteText(normalizePaletteText('first\nsecond'))
    expect(segments.atoms.map((atom) => atom.compact)).toEqual(['first', 'second'])
  })

  it('segments atoms without crossing whitespace', () => {
    const segments = segmentPaletteText(normalizePaletteText('scan daily 1.4.182 · 2026-08-13'))
    expect(segments.atoms.map((atom) => atom.compact)).toEqual([
      'scan',
      'daily',
      '14182',
      '',
      '20260813'
    ])
  })
})

describe('structured label matching', () => {
  const document = labelOnly('scan daily 1.4.182 · 2026-08-13 · 93334dc')

  it('matches several tokens inside one field', () => {
    const match = run(document, 'scan daily 08-13')
    expect(match).not.toBeNull()
    expect(match?.assignments).toHaveLength(3)
  })

  it.each(['0813', '08-13', '08/13', '20260813', '2026-08-13'])(
    'accepts the date alias %s',
    (alias) => {
      expect(run(document, alias)).not.toBeNull()
    }
  )

  it('rejects a reordered date and a different date', () => {
    expect(run(document, '13/08')).toBeNull()
    expect(run(document, '20260812')).toBeNull()
  })

  it('matches a compact version inside one atom', () => {
    expect(run(document, '4182')).not.toBeNull()
  })

  it('cannot join characters across atoms', () => {
    expect(run(document, 'daily1')).toBeNull()
  })

  it('removes results when an uncovered token is appended', () => {
    expect(run(document, 'scan daily')).not.toBeNull()
    expect(run(document, 'scan daily nope')).toBeNull()
  })

  it('never fuzzy-matches digit-bearing tokens', () => {
    expect(run(document, '93334dd')).toBeNull()
    expect(run(document, '1.4.183')).toBeNull()
  })

  it('applies light typo matching to long letter-only words', () => {
    expect(run(document, 'dayly')).not.toBeNull()
    expect(run(document, 'scam')?.rank.fuzzyTokenCount).toBe(1)
  })

  it('limits single Latin characters to word equality or prefix', () => {
    expect(run(labelOnly('alpha beta'), 'b')).not.toBeNull()
    expect(run(labelOnly('alpha beta'), 'l')).toBeNull()
  })

  it('lets a single non-Latin character substring match', () => {
    expect(run(labelOnly('重构登录流程'), '登')).not.toBeNull()
  })

  it('rejects punctuation-only tokens', () => {
    expect(run(labelOnly('alpha beta'), '--')).toBeNull()
  })
})

describe('identifier fields', () => {
  const review = (sigil: '#' | '!'): PaletteDocumentInput => ({
    id: 'doc',
    visibleFields: [{ id: 'name', profile: 'structured-label', text: 'reconnect flow' }],
    evidence: [
      {
        unit: { id: 'review', kind: 'pr', text: '#4123 · Fix reconnect', accessibilityLabel: 'PR' },
        fields: [
          {
            id: 'review#number',
            profile: 'identifier',
            text: '4123',
            evidenceId: 'review',
            renderOffset: 1,
            identifier: { kind: 'number', sigil }
          },
          {
            id: 'review#title',
            profile: 'prose',
            text: 'Fix reconnect',
            evidenceId: 'review',
            renderOffset: 8
          }
        ]
      }
    ]
  })

  it('matches the exact number and its sigil alias', () => {
    expect(run(review('#'), '4123')).not.toBeNull()
    expect(run(review('#'), '#4123')).not.toBeNull()
  })

  it('rejects an incidental numeric substring', () => {
    expect(run(review('#'), '123')).toBeNull()
  })

  it('keeps provider sigils apart', () => {
    expect(run(review('#'), '!4123')).toBeNull()
    expect(run(review('!'), '#4123')).toBeNull()
  })

  it('reports supporting evidence ranges against the rendered text', () => {
    const match = run(review('#'), '4123')
    const evidence = match?.supportingEvidence[0]
    expect(evidence?.text.slice(evidence.ranges[0].start, evidence.ranges[0].end)).toBe('4123')
  })

  it('combines an identity token with one evidence token', () => {
    const match = run(review('#'), 'reconnect 4123')
    expect(match?.rank.usesSupportingEvidence).toBe(1)
    expect(match?.supportingEvidence).toHaveLength(1)
  })
})

describe('duplicate evidence unit ids', () => {
  // Two listeners on one port with different process names: the scanner keys ports on
  // host:port:pid, so a parent and a forked child both survive.
  const duplicateUnits: PaletteDocumentInput = {
    id: 'doc',
    visibleFields: [{ id: 'name', profile: 'structured-label', text: 'checkout' }],
    evidence: [
      {
        unit: {
          id: 'port:3000',
          kind: 'port',
          text: '3000 · next-server',
          accessibilityLabel: 'Port'
        },
        fields: [
          {
            id: 'port:3000#name',
            profile: 'structured-label',
            text: 'next-server',
            evidenceId: 'port:3000',
            renderOffset: 7
          }
        ]
      },
      {
        unit: { id: 'port:3000', kind: 'port', text: '3000 · node', accessibilityLabel: 'Port' },
        fields: [
          {
            id: 'port:3000#name',
            profile: 'structured-label',
            text: 'node',
            evidenceId: 'port:3000',
            renderOffset: 7
          }
        ]
      }
    ]
  }

  it('keeps the first unit so its text matches the indexed fields', () => {
    // Why first-wins: indexPaletteFields keeps the first entry's fields, so overwriting the
    // unit paired one record's rendered text with another's offsets.
    const match = run(duplicateUnits, 'next-server')
    const evidence = match?.supportingEvidence[0]
    expect(evidence?.text).toBe('3000 · next-server')
    expect(evidence?.text.slice(evidence.ranges[0].start, evidence.ranges[0].end)).toBe(
      'next-server'
    )
  })

  it('never emits a range past the end of the rendered unit text', () => {
    for (const query of ['next-server', 'node', '3000']) {
      for (const evidence of run(duplicateUnits, query)?.supportingEvidence ?? []) {
        for (const range of evidence.ranges) {
          expect(range.end).toBeLessThanOrEqual(evidence.text.length)
          expect(range.start).toBeLessThan(range.end)
        }
      }
    }
  })
})

describe('evidence limits', () => {
  const twoUnits: PaletteDocumentInput = {
    id: 'doc',
    visibleFields: [{ id: 'name', profile: 'structured-label', text: 'checkout' }],
    evidence: [
      {
        unit: { id: 'port:3000', kind: 'port', text: '3000 · node', accessibilityLabel: 'Port' },
        fields: [
          {
            id: 'port:3000#number',
            profile: 'identifier',
            text: '3000',
            evidenceId: 'port:3000',
            renderOffset: 0,
            identifier: { kind: 'port' }
          }
        ]
      },
      {
        unit: {
          id: 'comment',
          kind: 'comment',
          text: 'waiting on infra',
          accessibilityLabel: 'Comment'
        },
        fields: [
          {
            id: 'comment#text',
            profile: 'prose',
            text: 'waiting on infra',
            evidenceId: 'comment',
            renderOffset: 0
          }
        ]
      }
    ]
  }

  it('accepts one hidden source', () => {
    expect(run(twoUnits, 'checkout 3000')).not.toBeNull()
  })

  it('rejects assignments that need two hidden sources', () => {
    expect(run(twoUnits, '3000 infra')).toBeNull()
  })

  it('prefers visible evidence over supporting evidence', () => {
    const match = run(twoUnits, 'checkout')
    expect(match?.rank.usesSupportingEvidence).toBe(0)
    expect(match?.supportingEvidence).toHaveLength(0)
  })
})

describe('typo distance', () => {
  it.each([
    ['daily', 'dayly', true],
    ['daily', 'daily', true],
    ['daily', 'dail', true],
    ['daily', 'dailly', true],
    // Transposition is two edits, so a banded distance of one rejects it.
    ['daily', 'dialy', false],
    ['daily', 'da', false]
  ])('%s vs %s -> %s', (a, b, expected) => {
    expect(isWithinOnePaletteEdit(a, b)).toBe(expected)
  })
})

describe('container field matching', () => {
  it('counts a container-only token and demotes quality class when every token lands on containers', () => {
    const tabDoc: PaletteDocumentInput = {
      id: 'tab-1',
      visibleFields: [
        { id: 'title', profile: 'structured-label', text: 'README.md' },
        { id: 'worktree', profile: 'structured-label', text: 'STA-4360-feature', isContainer: true }
      ],
      evidence: []
    }
    const match = run(tabDoc, '4360')
    expect(match).not.toBeNull()
    expect(match?.rank.containerOnlyTokenCount).toBe(1)
    expect(match?.qualityClass).toBe('exact-evidence')
  })

  it('does not count a token that lands on a direct field', () => {
    const tabDoc: PaletteDocumentInput = {
      id: 'tab-1',
      visibleFields: [
        { id: 'title', profile: 'structured-label', text: 'wsl-transcript-4360.ts' },
        { id: 'worktree', profile: 'structured-label', text: 'STA-4360-feature', isContainer: true }
      ],
      evidence: []
    }
    const match = run(tabDoc, '4360')
    expect(match).not.toBeNull()
    expect(match?.rank.containerOnlyTokenCount).toBe(0)
    expect(match?.qualityClass).toBe('exact-visible')
  })

  it('ranks an all-direct multi-token match ahead of a mixed direct and container match', () => {
    const direct = run(
      {
        id: 'direct',
        visibleFields: [
          { id: 'title', profile: 'structured-label', text: 'alpha' },
          { id: 'path', profile: 'structured-label', text: 'beta' }
        ],
        evidence: []
      },
      'alpha beta'
    )
    const mixed = run(
      {
        id: 'mixed',
        visibleFields: [
          { id: 'title', profile: 'structured-label', text: 'alpha' },
          { id: 'worktree', profile: 'structured-label', text: 'beta', isContainer: true }
        ],
        evidence: []
      },
      'alpha beta'
    )

    expect(direct).not.toBeNull()
    expect(mixed).not.toBeNull()
    expect(direct?.rank.containerOnlyTokenCount).toBe(0)
    expect(mixed?.rank.containerOnlyTokenCount).toBe(1)
    if (direct && mixed) {
      expect(comparePaletteDocumentRank(direct.rank, mixed.rank)).toBeLessThan(0)
    }
  })
})
