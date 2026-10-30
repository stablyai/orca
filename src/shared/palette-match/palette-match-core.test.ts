import { describe, expect, it } from 'vitest'
import { matchPaletteDocument } from './match-document'
import { mapNormalizedRange, normalizePaletteText } from './normalized-text'
import { preparePaletteQuery, PALETTE_QUERY_MAX_TOKENS } from './palette-query'
import { buildPaletteDocument, type PaletteDocumentInput } from './palette-document'

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
    normalizedQuery: prepared.normalized,
    tokenCountBeforeDeduplication: prepared.tokenCountBeforeDeduplication
  })
}

const labelOnly = (text: string): PaletteDocumentInput => ({
  id: 'doc',
  visibleFields: [
    {
      id: 'name',
      profile: 'structured-label',
      text,
      role: 'primary',
      destinationEligible: true
    }
  ],
  evidence: []
})

describe('palette query preparation', () => {
  it('treats emoji and symbols as content, not punctuation', () => {
    // Emoji expansion produces symbol queries; dropping symbols would make the palette unable to match its own input.
    expect(ready('🚀 rocket').tokens[0]?.isPunctuationOnly).toBe(false)
    expect(run(labelOnly('🚀 rocket ship'), '🚀 rocket ship')).not.toBeNull()
    expect(run(labelOnly('a → b'), '→')).not.toBeNull()
    // A genuinely punctuation-only token stays rejected.
    expect(ready('--').tokens[0]?.isPunctuationOnly).toBe(true)
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
})

describe('normalization and ranges', () => {
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
})

describe('structured label matching', () => {
  const document = labelOnly('scan daily 1.4.182 · 2026-08-13 · 93334dc')

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
    expect(run(document, 'scam')?.rank.recovery).toBe(1)
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
    visibleFields: [
      {
        id: 'name',
        profile: 'structured-label',
        text: 'reconnect flow',
        role: 'primary',
        destinationEligible: true
      }
    ],
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
})

describe('duplicate evidence unit ids', () => {
  // Scanner identity includes PID, so parent/child listeners on one port must both survive.
  const duplicateUnits: PaletteDocumentInput = {
    id: 'doc',
    visibleFields: [
      {
        id: 'name',
        profile: 'structured-label',
        text: 'checkout',
        role: 'primary',
        destinationEligible: true
      }
    ],
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
            renderOffset: 0
          }
        ]
      }
    ]
  }

  it('keeps the first unit so its text matches the indexed fields', () => {
    // Retain first units and fields together or offsets would highlight a different record’s rendered text.
    const match = run(duplicateUnits, 'next-server')
    const evidence = match?.supportingEvidence[0]
    expect(evidence?.text).toBe('3000 · next-server')
    expect(evidence?.text.slice(evidence.ranges[0].start, evidence.ranges[0].end)).toBe(
      'next-server'
    )
  })
})

describe('evidence limits', () => {
  const twoUnits: PaletteDocumentInput = {
    id: 'doc',
    visibleFields: [
      {
        id: 'name',
        profile: 'structured-label',
        text: 'checkout',
        role: 'primary',
        destinationEligible: true
      }
    ],
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
})

describe('container field matching', () => {
  it('counts a container-only token and demotes quality class when every token lands on containers', () => {
    const tabDoc: PaletteDocumentInput = {
      id: 'tab-1',
      visibleFields: [
        {
          id: 'title',
          profile: 'structured-label',
          text: 'README.md',
          role: 'primary',
          destinationEligible: true
        },
        {
          id: 'worktree',
          profile: 'structured-label',
          text: 'STA-4360-feature',
          role: 'container',
          destinationEligible: false
        }
      ],
      evidence: []
    }
    const match = run(tabDoc, '4360')
    expect(match).not.toBeNull()
    expect(match?.rank.coverage).toBe(2)
    expect(match?.qualityClass).toBe('exact-evidence')
  })
})
