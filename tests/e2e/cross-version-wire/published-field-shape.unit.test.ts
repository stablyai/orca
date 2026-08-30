import { describe, expect, it } from 'vitest'
import {
  comparePublishedFieldOccurrences,
  comparePublishedFields,
  publishedFieldNames
} from './published-field-shape'

describe('published field shape', () => {
  it('sorts the keys from one published frame occurrence', () => {
    expect(publishedFieldNames({ seq: 27, kind: 'scrollback', requestId: 1 })).toEqual([
      'kind',
      'requestId',
      'seq'
    ])
  })

  it('detects a field removed from only one corresponding occurrence', () => {
    expect(
      comparePublishedFieldOccurrences({
        older: [
          { kind: 'scrollback', seq: 0 },
          { kind: 'scrollback', seq: 27, requestId: 1 },
          { kind: 'scrollback', seq: 27 }
        ],
        newer: [
          { kind: 'scrollback', seq: 0 },
          { kind: 'scrollback', requestId: 1 },
          { kind: 'scrollback', seq: 27 }
        ]
      })
    ).toEqual([
      { added: [], removed: [] },
      { added: [], removed: ['seq'] },
      { added: [], removed: [] }
    ])
  })

  it('rejects unequal occurrence counts instead of truncating the comparison', () => {
    expect(() =>
      comparePublishedFieldOccurrences({
        older: [{ kind: 'scrollback' }, { kind: 'scrollback' }],
        newer: [{ kind: 'scrollback' }]
      })
    ).toThrow(/occurrence count differs: older 2, newer 1/)
  })

  it('reads an empty payload as no fields, which is what the anti-vacuous check tests', () => {
    expect(publishedFieldNames({})).toEqual([])
  })

  it('reports an added field as added and nothing as removed', () => {
    expect(
      comparePublishedFields({
        older: ['cols', 'kind', 'rows'],
        newer: ['alternateScreen', 'cols', 'kind', 'rows', 'terminalOwner']
      })
    ).toEqual({ added: ['alternateScreen', 'terminalOwner'], removed: [] })
  })

  it('reports a field the newer side stopped publishing as removed', () => {
    expect(
      comparePublishedFields({
        older: ['cols', 'kind', 'rows', 'source'],
        newer: ['cols', 'kind', 'rows']
      })
    ).toEqual({ added: [], removed: ['source'] })
  })

  it('is silent when both sides publish the same names in a different order', () => {
    expect(comparePublishedFields({ older: ['rows', 'cols'], newer: ['cols', 'rows'] })).toEqual({
      added: [],
      removed: []
    })
  })

  it('does not repeat a name a caller passed twice', () => {
    expect(comparePublishedFields({ older: [], newer: ['seq', 'seq'] })).toEqual({
      added: ['seq'],
      removed: []
    })
  })
})
