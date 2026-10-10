import { describe, expect, it } from 'vitest'
import { GROK_MODEL_LIST_ARGS, parseGrokModelList } from './grok-model-list-probe'

// Captured byte-for-byte from `grok models` on a signed-in account (`sed -n l`),
// blank lines and the two-space bullet indent included.
const SIGNED_IN_STDOUT = [
  'You are logged in with grok.com.',
  '',
  'Default model: grok-4.6',
  '',
  'Available models:',
  '  * grok-4.6 (default)',
  '  - grok-4.5',
  ''
].join('\n')

describe('parseGrokModelList', () => {
  it('probes with the only listing subcommand grok exposes', () => {
    expect(GROK_MODEL_LIST_ARGS).toEqual(['models'])
  })

  it('parses the signed-in listing into exactly the bulleted models', () => {
    // Regression: grok stars only the default row and dashes the rest, so a `*`-only
    // bullet pattern published a one-model list and dropped every other model —
    // and discovery is authoritative, so the dropped rows left the picker entirely.
    expect(parseGrokModelList(SIGNED_IN_STDOUT)).toEqual([
      { id: 'grok-4.6', label: 'Grok 4.6', isDefault: true },
      { id: 'grok-4.5', label: 'Grok 4.5' }
    ])
  })

  it('marks only the row the listing itself annotates', () => {
    const parsed = parseGrokModelList(
      'Available models:\n  * grok-build\n  * grok-4.5 (default)\n  * grok-mini\n'
    )
    expect(parsed.map(({ id, isDefault }) => [id, isDefault])).toEqual([
      ['grok-build', undefined],
      ['grok-4.5', true],
      ['grok-mini', undefined]
    ])
  })

  it('names no default when the listing annotates none', () => {
    // Better to show nothing than to promote the first row: an unflagged launch
    // would run whichever model the CLI picks, not this one.
    const parsed = parseGrokModelList('Available models:\n  * grok-4.5\n  * grok-build\n')
    expect(parsed.every(({ isDefault }) => isDefault === undefined)).toBe(true)
  })

  it('does not treat another parenthetical as the default marker', () => {
    const parsed = parseGrokModelList('Available models:\n  * grok-build (beta)\n')
    expect(parsed[0]!.isDefault).toBeUndefined()
  })

  it('ignores the decoy ids that sit above the header', () => {
    // `Default model: grok-4.6` is a valid-looking id and the login line holds a
    // dotted token; both precede the header, so neither may become a model.
    const parsed = parseGrokModelList(SIGNED_IN_STDOUT)
    expect(parsed).toHaveLength(2)
    expect(parsed.some(({ id }) => id.includes('grok.com'))).toBe(false)
  })

  it('reads the default marker off a dashed row too', () => {
    // The bullet grok uses is presentational; only the annotation is the claim.
    expect(
      parseGrokModelList('Available models:\n  - grok-build\n  - grok-4.5 (default)\n').map(
        ({ id, isDefault }) => [id, isDefault]
      )
    ).toEqual([
      ['grok-build', undefined],
      ['grok-4.5', true]
    ])
  })

  it('strips a trailing parenthetical annotation from the id, spaced or not', () => {
    const parsed = parseGrokModelList(
      'Available models:\n  * grok-4.5 (default)\n  * grok-build(beta)\n'
    )
    expect(parsed.map(({ id }) => id)).toEqual(['grok-4.5', 'grok-build'])
  })

  it('keeps hyphens and dots inside an id', () => {
    const parsed = parseGrokModelList('Available models:\n  * grok-4.5-fast-2026.07.19\n')
    expect(parsed).toEqual([{ id: 'grok-4.5-fast-2026.07.19', label: 'Grok 4.5 Fast 2026.07.19' }])
  })

  it('parses several models in listing order and deduplicates', () => {
    const parsed = parseGrokModelList(
      'Available models:\n  * grok-4.5 (default)\n  * grok-build\n  * grok-4.5\n'
    )
    expect(parsed.map(({ id }) => id)).toEqual(['grok-4.5', 'grok-build'])
  })

  it('tolerates CRLF line endings', () => {
    expect(parseGrokModelList('Available models:\r\n  * grok-4.5 (default)\r\n')).toEqual([
      { id: 'grok-4.5', label: 'Grok 4.5', isDefault: true }
    ])
  })

  it('returns nothing when the header is missing, whatever follows', () => {
    // A bullet list with no header is the shape a reworded CLI would emit; half
    // a parse here would publish phantom models as an authoritative list.
    expect(parseGrokModelList('Models:\n  * grok-4.5 (default)\n')).toEqual([])
    expect(parseGrokModelList('Default model: grok-4.5\n')).toEqual([])
  })

  it('returns nothing for a header with no bullets under it', () => {
    expect(parseGrokModelList('Available models:\n')).toEqual([])
    expect(parseGrokModelList('Available models:\n\n  (none)\n')).toEqual([])
  })

  it('returns nothing for empty, signed-out, or arbitrary output', () => {
    expect(parseGrokModelList('')).toEqual([])
    expect(parseGrokModelList('\n\n   \n')).toEqual([])
    // Synthetic: the live signed-out path was never run against a real account.
    expect(parseGrokModelList('You are not logged in. Run `grok login` to continue.\n')).toEqual([])
    expect(parseGrokModelList("error: unexpected argument '--json' found\n")).toEqual([])
  })

  it('stops at the blank line that ends the listing section', () => {
    // A footer bullet parsed as a model becomes a selectable row, and picking it
    // launches `-m Set` — so the section boundary has to be respected.
    expect(
      parseGrokModelList(
        'Available models:\n  * grok-4.5 (default)\n\nTips:\n  * Set a default with `grok config`\n'
      ).map(({ id }) => id)
    ).toEqual(['grok-4.5'])
  })

  it('takes the default marker from a repeated row it would otherwise skip', () => {
    expect(parseGrokModelList('Available models:\n  * grok-4.5\n  * grok-4.5 (default)\n')).toEqual(
      [{ id: 'grok-4.5', label: 'Grok 4.5', isDefault: true }]
    )
  })

  it('still reads a listing whose bullets start after a blank line', () => {
    expect(
      parseGrokModelList('Available models:\n\n  * grok-4.5 (default)\n').map(({ id }) => id)
    ).toEqual(['grok-4.5'])
  })

  it('never emits an entry without both an id and a label', () => {
    const stdouts = [
      SIGNED_IN_STDOUT,
      'Available models:\n  * \n  *\n  * grok-4.5\n',
      'Available models:\n  * (default)\n'
    ]
    for (const stdout of stdouts) {
      for (const model of parseGrokModelList(stdout)) {
        expect(model.id.length).toBeGreaterThan(0)
        expect(model.label.length).toBeGreaterThan(0)
        expect(model.id).not.toMatch(/[\s(]/)
      }
    }
  })
})
