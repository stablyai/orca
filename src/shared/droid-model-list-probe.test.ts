import { describe, expect, it } from 'vitest'
import { DROID_MODEL_LIST_ARGS, parseDroidModelList } from './droid-model-list-probe'

// Verbatim excerpt of `droid exec --help` (v0.191.1), including the surrounding
// prose the parser must ignore.
const HELP = `Autonomy Levels:
  --auto low                 Low-risk operations - Basic file operations
                             • File creation/modification in non-system directories

Examples:
  droid exec --model gpt-5 --list-tools --output-format json
  droid exec --model custom:deepseek-v3 "analyze this code"

Model details:
  - Auto Model: supports reasoning: No; supported: [none]; default: none
  - Fable 5: supports reasoning: Yes; supported: [off, low, medium, high, xhigh, max]; default: high
  - Opus 5 Fast Mode: supports reasoning: Yes; supported: [off, low, medium, high, xhigh, max]; default: high
  - GPT-5.6 Sol: supports reasoning: Yes; supported: [none, low, medium, high, xhigh, max]; default: medium
  - Gemini 3.6 Flash: supports reasoning: Yes; supported: [minimal, low, medium, high]; default: high
  - GLM-5.2 (Droid Core): supports reasoning: Yes; supported: [off, high, max]; default: high
`

describe('parseDroidModelList', () => {
  it('probes through the one machine-readable surface droid exposes', () => {
    expect(DROID_MODEL_LIST_ARGS).toEqual(['exec', '--help'])
  })

  it('reads the account model list in the CLI\u2019s own order', () => {
    expect(parseDroidModelList(HELP).map(({ label }) => label)).toEqual([
      'Auto Model',
      'Fable 5',
      'Opus 5 Fast Mode',
      'GPT-5.6 Sol',
      'Gemini 3.6 Flash',
      'GLM-5.2 (Droid Core)'
    ])
  })

  // The interactive CLI takes no model id, so the label is the identity — see the
  // module comment. A slugged id would be one the CLI never publishes.
  it('identifies models by their printed label', () => {
    expect(parseDroidModelList(HELP)[3]).toEqual({ id: 'GPT-5.6 Sol', label: 'GPT-5.6 Sol' })
  })

  it('ignores everything outside the model-details section', () => {
    const models = parseDroidModelList(HELP)
    expect(models.some(({ label }) => label.includes('droid exec'))).toBe(false)
    expect(models.some(({ label }) => label.includes('auto low'))).toBe(false)
  })

  it('claims no models when the section is absent or the format moved', () => {
    expect(parseDroidModelList('')).toEqual([])
    expect(parseDroidModelList('Options:\n  -m, --model <id>  Model ID to use')).toEqual([])
    expect(parseDroidModelList('Model details:\n  - Opus 5\n  - Sonnet 5\n')).toEqual([])
  })

  it('names no default: droid picks one from account settings, not a flag', () => {
    expect(parseDroidModelList(HELP).some((model) => model.isDefault)).toBe(false)
  })

  it('keeps the first row when a label repeats', () => {
    const duplicated = `Model details:
  - Opus 5: supports reasoning: Yes; supported: [off, high]; default: high
  - Opus 5: supports reasoning: Yes; supported: [off, high]; default: high
`
    expect(parseDroidModelList(duplicated)).toEqual([{ id: 'Opus 5', label: 'Opus 5' }])
  })
})
