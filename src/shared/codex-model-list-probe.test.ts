import { describe, expect, it, vi } from 'vitest'
import { CODEX_MODEL_LIST_MAX_JSON_CHARACTERS, parseCodexModelList } from './codex-model-list-probe'

describe('Codex model list probe', () => {
  it('parses advertised reasoning levels and keeps hidden rows for callers to filter', () => {
    expect(
      parseCodexModelList(
        JSON.stringify({
          models: [
            {
              slug: 'gpt-5.6-luna',
              display_name: 'GPT-5.6-Luna',
              default_reasoning_level: 'medium',
              visibility: 'list',
              supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }]
            },
            {
              slug: 'codex-auto-review',
              display_name: 'Codex Auto Review',
              visibility: 'hide',
              supported_reasoning_levels: [{ effort: 'max' }]
            }
          ]
        })
      )
    ).toEqual([
      {
        id: 'gpt-5.6-luna',
        label: 'GPT-5.6-Luna',
        effortLevels: ['low', 'max'],
        defaultEffort: 'medium',
        visibility: 'list'
      },
      {
        id: 'codex-auto-review',
        label: 'Codex Auto Review',
        effortLevels: ['max'],
        defaultEffort: null,
        visibility: 'hide'
      }
    ])
  })

  it('returns no models for malformed or empty output so callers keep their seed', () => {
    expect(parseCodexModelList('')).toEqual([])
    expect(parseCodexModelList('garbage')).toEqual([])
    expect(parseCodexModelList('{"models":false}')).toEqual([])
  })

  it('rejects oversized output before JSON.parse', () => {
    const parseSpy = vi.spyOn(JSON, 'parse')
    try {
      expect(parseCodexModelList(' '.repeat(CODEX_MODEL_LIST_MAX_JSON_CHARACTERS + 1))).toEqual([])
      expect(parseSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
    }
  })
})
