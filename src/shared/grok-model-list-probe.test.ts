import { describe, expect, it } from 'vitest'
import { parseGrokModelList } from './grok-model-list-probe'

// Byte-exact signed-in grok models capture, including blank lines/two-space bullet indent (sed -n l).
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
  it('parses the signed-in listing into exactly the bulleted models', () => {
    // A star-only parser dropped dashed non-default rows from authoritative discovery, removing them from the picker.
    expect(parseGrokModelList(SIGNED_IN_STDOUT)).toEqual([
      { id: 'grok-4.6', label: 'Grok 4.6', isDefault: true },
      { id: 'grok-4.5', label: 'Grok 4.5' }
    ])
  })

  it('names no default when the listing annotates none', () => {
    // Without an explicit marker, first-row promotion would misrepresent the CLI’s unflagged default.
    const parsed = parseGrokModelList('Available models:\n  * grok-4.5\n  * grok-build\n')
    expect(parsed.map(({ id, isDefault }) => [id, isDefault])).toEqual([
      ['grok-4.5', undefined],
      ['grok-build', undefined]
    ])
  })

  it('returns nothing when the header is missing, whatever follows', () => {
    // Unrecognized listing headers must not publish partial authoritative model lists.
    expect(parseGrokModelList('Models:\n  * grok-4.5 (default)\n')).toEqual([])
    expect(parseGrokModelList('Default model: grok-4.5\n')).toEqual([])
  })

  it('stops at the blank line that ends the listing section', () => {
    // Footer bullets must not become selectable IDs that launch e.g. -m Set.
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
})
