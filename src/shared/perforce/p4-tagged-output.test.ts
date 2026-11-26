import { describe, expect, it } from 'vitest'
import { parseTaggedOutput } from './p4-tagged-output'

describe('parseTaggedOutput', () => {
  it('splits records on blank lines', () => {
    const out =
      '... depotFile //d/a.txt\n... action edit\n\n... depotFile //d/b.txt\n... action add\n'
    expect(parseTaggedOutput(out)).toEqual([
      { depotFile: '//d/a.txt', action: 'edit' },
      { depotFile: '//d/b.txt', action: 'add' }
    ])
  })

  it('starts a new record when the first key repeats without a separator', () => {
    const out =
      '... depotFile //d/a.txt\n... action edit\n... depotFile //d/b.txt\n... action add\n'
    expect(parseTaggedOutput(out)).toHaveLength(2)
  })

  it('keeps multi-line values, including blank lines, in one field', () => {
    const out = '... change 12\n... desc first\n\nsecond\n\n... change 11\n... desc other\n'
    const records = parseTaggedOutput(out)
    expect(records).toHaveLength(2)
    expect(records[0]?.desc).toBe('first\n\nsecond')
  })

  it('keeps fields that follow a multi-line description in the same record', () => {
    const out =
      '... change 4\n... desc Renamed\n\n... status pending\n... depotFile0 //d/a\n... action0 edit\n\n... change 3\n... desc x\n\n... status pending\n'
    const records = parseTaggedOutput(out)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ change: '4', depotFile0: '//d/a', action0: 'edit' })
    expect(records[1]?.change).toBe('3')
  })

  it('returns no records for empty output', () => {
    expect(parseTaggedOutput('')).toEqual([])
  })
})
