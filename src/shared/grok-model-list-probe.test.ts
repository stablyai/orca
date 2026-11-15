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
})
