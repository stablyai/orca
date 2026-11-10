import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'

const parseCursorModels = getAgentSessionOptionCatalog('cursor')!.listModels!.parse

// Row shape newer cursor-agent reports for `cursor-agent models` (#40661): an unadorned
// header followed by `id - Label` rows, with the default flagged in a marker.
const LABELED_STDOUT = [
  'Available models',
  'auto - Auto (default)',
  'gpt-5.3-codex-low - Codex 5.3 Low',
  'gpt-5.3-codex-high - Codex 5.3 High',
  'claude-opus-5-thinking-high - Opus 5.5 Thinking High',
  ''
].join('\n')

// Older hosts printed one bare id per row, optionally bulleted or annotated.
const BARE_STDOUT = [
  'Available models:',
  '  - auto',
  '  - gpt-5.3-codex (Codex)',
  '* claude-opus-4-8',
  ''
].join('\n')

describe('parseCursorModels', () => {
  it('parses newer id - Label rows with their real labels', () => {
    // The bare-id pattern rejects `auto - Auto (default)`, so discovery returned nothing and
    // the picker fell back to the hardcoded seed list.
    expect(parseCursorModels(LABELED_STDOUT)).toEqual([
      { id: 'auto', label: 'Auto', isDefault: true, options: [] },
      { id: 'gpt-5.3-codex-low', label: 'Codex 5.3 Low', options: [] },
      { id: 'gpt-5.3-codex-high', label: 'Codex 5.3 High', options: [] },
      { id: 'claude-opus-5-thinking-high', label: 'Opus 5.5 Thinking High', options: [] }
    ])
  })

  it('keeps parsing older bare-id rows, bullets and notes', () => {
    expect(parseCursorModels(BARE_STDOUT)).toEqual([
      { id: 'auto', label: 'Auto', options: [] },
      { id: 'gpt-5.3-codex', label: 'gpt-5.3-codex', options: [] },
      { id: 'claude-opus-4-8', label: 'claude-opus-4-8', options: [] }
    ])
  })

  it('keeps a bullet prefix from hiding a labeled row', () => {
    const parsed = parseCursorModels('- auto - Auto (default)\n')
    expect(parsed).toEqual([{ id: 'auto', label: 'Auto', isDefault: true, options: [] }])
  })

  it('skips headers, preambles and duplicate rows in mixed listings', () => {
    const parsed = parseCursorModels(
      [
        'You are logged in.',
        'Default model: auto',
        'Available models',
        'auto - Auto (default)',
        'auto - Auto (default)',
        ''
      ].join('\n')
    )
    expect(parsed).toEqual([{ id: 'auto', label: 'Auto', isDefault: true, options: [] }])
  })

  it('strips a (current) marker without naming a default', () => {
    const parsed = parseCursorModels('Available models\nopus-5 - Opus 5 (current)\n')
    expect(parsed).toEqual([{ id: 'opus-5', label: 'Opus 5', options: [] }])
  })
})
