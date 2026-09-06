import { describe, expect, it } from 'vitest'
import {
  isOmpAdvisorCard,
  ompAdvisorNotesText,
  ompAdvisorTurnId,
  readOmpAdvisorNotes
} from './omp-advisor-notes'

describe('OMP advisor card recognition', () => {
  it('recognizes a persisted advisor custom_message entry', () => {
    expect(isOmpAdvisorCard({ type: 'custom_message', customType: 'advisor' })).toBe(true)
  })

  it('rejects other custom types and non-objects', () => {
    expect(isOmpAdvisorCard({ customType: 'rewind-report' })).toBe(false)
    expect(isOmpAdvisorCard({})).toBe(false)
    expect(isOmpAdvisorCard(null)).toBe(false)
  })
})

describe('OMP advisor note extraction', () => {
  it('prefers the structured details.notes payload', () => {
    const notes = readOmpAdvisorNotes({
      customType: 'advisor',
      content:
        '<advisory severity="nit" guidance="weigh, don\'t blindly obey">\nignored\n</advisory>',
      details: {
        notes: [{ note: 'Stay silent — the answer already matches the ask.', severity: 'nit' }]
      }
    })
    expect(notes).toEqual([
      { note: 'Stay silent — the answer already matches the ask.', severity: 'nit' }
    ])
  })

  it('keeps the advisor name when a roster advisor raised the note', () => {
    const notes = readOmpAdvisorNotes({
      customType: 'advisor',
      details: {
        notes: [{ note: 'Watch the coupling.', severity: 'concern', advisor: 'Architecture' }]
      }
    })
    expect(notes).toEqual([
      { note: 'Watch the coupling.', severity: 'concern', advisor: 'Architecture' }
    ])
  })

  it('drops a severity outside the documented nit/concern/blocker set', () => {
    const notes = readOmpAdvisorNotes({
      customType: 'advisor',
      details: { notes: [{ note: 'Hm.', severity: 'recap' }] }
    })
    expect(notes).toEqual([{ note: 'Hm.' }])
  })

  it('falls back to parsing the <advisory> elements when details is absent', () => {
    const notes = readOmpAdvisorNotes({
      customType: 'advisor',
      content:
        '<advisory advisor="Architecture" severity="concern" guidance="weigh, don\'t blindly obey">\n' +
        'Prefer a &lt;div&gt; over a &amp; hack.\n' +
        '</advisory>\n' +
        '<advisory severity="nit" guidance="weigh, don\'t blindly obey">\nTrim the dead import.\n</advisory>'
    })
    expect(notes).toEqual([
      { note: 'Prefer a <div> over a & hack.', severity: 'concern', advisor: 'Architecture' },
      { note: 'Trim the dead import.', severity: 'nit' }
    ])
  })

  it('un-escapes a quote in the advisor attribute value', () => {
    const notes = readOmpAdvisorNotes({
      customType: 'advisor',
      content: '<advisory advisor="The &quot;Fixer&quot;" guidance="x">\nnote\n</advisory>'
    })
    expect(notes).toEqual([{ note: 'note', advisor: 'The "Fixer"' }])
  })

  it('reads content delivered as a text content-block array', () => {
    const notes = readOmpAdvisorNotes({
      customType: 'advisor',
      content: [
        { type: 'text', text: '<advisory guidance="x">\nfrom a block\n</advisory>' },
        { type: 'image', data: 'ignored' }
      ]
    })
    expect(notes).toEqual([{ note: 'from a block' }])
  })

  it('returns nothing for a non-advisor card or an empty note', () => {
    expect(readOmpAdvisorNotes({ customType: 'irc:incoming', content: 'hi' })).toEqual([])
    expect(
      readOmpAdvisorNotes({ customType: 'advisor', details: { notes: [{ note: '   ' }] } })
    ).toEqual([])
  })
})

describe('OMP advisor turn identity', () => {
  it('is stable across the structured and XML carriers of the same card', () => {
    const structured = readOmpAdvisorNotes({
      customType: 'advisor',
      details: {
        notes: [{ note: 'Watch the coupling.', severity: 'concern', advisor: 'Architecture' }]
      }
    })
    const fromXml = readOmpAdvisorNotes({
      customType: 'advisor',
      content:
        '<advisory advisor="Architecture" severity="concern" guidance="x">\nWatch  the\ncoupling.\n</advisory>'
    })
    expect(ompAdvisorTurnId(fromXml, 1_700_000_000_000)).toBe(
      ompAdvisorTurnId(structured, 1_700_000_000_000)
    )
  })

  it('separates two notes that differ only by severity or advisor', () => {
    const nit = ompAdvisorTurnId([{ note: 'same text', severity: 'nit' }], 10)
    const blocker = ompAdvisorTurnId([{ note: 'same text', severity: 'blocker' }], 10)
    const named = ompAdvisorTurnId([{ note: 'same text', severity: 'nit', advisor: 'Fixer' }], 10)
    expect(new Set([nit, blocker, named]).size).toBe(3)
  })

  // An advisor may legitimately re-raise identical text after a reset or a
  // history rewrite. Without the card's own clock the new card inherits the
  // older one's identity, and the overlay treats the stale transcript row as
  // coverage — suppressing live advice that may never arrive any other way.
  it('separates a re-raised identical note by the card clock', () => {
    const notes = [{ note: 'same text', severity: 'nit' as const, advisor: 'Fixer' }]
    expect(ompAdvisorTurnId(notes, 20)).not.toBe(ompAdvisorTurnId(notes, 21))
  })

  it('collapses the same card reported by two carriers on one clock', () => {
    const notes = [{ note: 'same text', severity: 'nit' as const }]
    expect(ompAdvisorTurnId(notes, 20)).toBe(ompAdvisorTurnId([...notes], 20))
  })

  // A carrier that dropped the clock still gets a usable identity; it just
  // falls back to the content-only key rather than inventing a timestamp.
  it('falls back to a clockless identity, distinct from any clocked one', () => {
    const notes = [{ note: 'same text', severity: 'nit' as const }]
    expect(ompAdvisorTurnId(notes, null)).not.toBeNull()
    expect(ompAdvisorTurnId(notes, null)).not.toBe(ompAdvisorTurnId(notes, 20))
  })

  // The note text is user/model prose, so it can contain the very characters
  // that separate one note from the next. Unescaped, one note spelling
  // `x|//y` would be indistinguishable from the two notes `x` and `y`, and the
  // second card would be discarded as a duplicate of the first.
  it('separates batches whose note text contains the identity delimiters', () => {
    const spelled = ompAdvisorTurnId([{ note: 'x|//y' }], 20)
    const split = ompAdvisorTurnId([{ note: 'x' }, { note: 'y' }], 20)
    expect(spelled).not.toBe(split)
  })

  it('separates an advisor name that spells a severity boundary', () => {
    const inName = ompAdvisorTurnId([{ note: 'text', advisor: 'a/nit' }], 20)
    const inSeverity = ompAdvisorTurnId([{ note: 'text', advisor: 'a', severity: 'nit' }], 20)
    expect(inName).not.toBe(inSeverity)
  })

  // SA-006: the identity has to be injective over what the card actually
  // DISPLAYS. Lowercasing collapsed two genuinely different notes onto one
  // turnId, and appendOmpRpcAdvisorCard then dropped the second as a duplicate
  // — so its distinct text never rendered. Whitespace stays normalized because
  // the XML carrier really does re-wrap the prose; no carrier rewrites case.
  it('separates two notes that differ only by letter case', () => {
    expect(ompAdvisorTurnId([{ note: 'Check Foo' }], 20)).not.toBe(
      ompAdvisorTurnId([{ note: 'Check foo' }], 20)
    )
  })

  it('has no identity for an empty batch', () => {
    expect(ompAdvisorTurnId([], 20)).toBeNull()
  })
})

describe('OMP advisor note rendering', () => {
  it('labels the default advisor with its severity', () => {
    expect(ompAdvisorNotesText([{ note: 'Trim the dead import.', severity: 'nit' }])).toBe(
      '※ advisor · nit\nTrim the dead import.'
    )
  })

  it('names a roster advisor ahead of the severity', () => {
    expect(
      ompAdvisorNotesText([
        { note: 'Watch the coupling.', severity: 'concern', advisor: 'Architecture' }
      ])
    ).toBe('※ advisor · Architecture · concern\nWatch the coupling.')
  })

  it('renders a batched card as one block per note', () => {
    expect(
      ompAdvisorNotesText([
        { note: 'first', severity: 'nit' },
        { note: 'second', advisor: 'Fixer' }
      ])
    ).toBe('※ advisor · nit\nfirst\n\n※ advisor · Fixer\nsecond')
  })

  it('renders an unlabelled note under the bare header', () => {
    expect(ompAdvisorNotesText([{ note: 'plain' }])).toBe('※ advisor\nplain')
  })
})
