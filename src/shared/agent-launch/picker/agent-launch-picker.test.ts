import { agentPickerEntryOptions } from './agent-launch-picker-catalog'
import { describe, expect, it } from 'vitest'

describe('agent launch picker', () => {
  it('shows per-model Antigravity efforts on chat and terminal while hiding them for standalone models', () => {
    const entry = {
      agent: 'antigravity' as const,
      terminal: {},
      catalog: {
        origin: 'probe' as const,
        fetchedAt: 1,
        listingNamesConfiguredModel: false,
        models: [
          {
            id: 'gemini-4-hydrogen',
            label: 'Gemini 4 Hydrogen',
            isDefault: false,
            efforts: [
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
              { value: 'xhigh', label: 'Extra high' }
            ]
          },
          {
            id: 'claude-opus-5-5',
            label: 'Claude Opus 5.5',
            isDefault: false,
            efforts: [
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' }
            ]
          },
          {
            id: 'gemini-pro-orchestrator',
            label: 'Orchestrator (Carbon)',
            isDefault: false,
            efforts: []
          },
          {
            id: 'gpt-oss-120b-medium',
            label: 'GPT-OSS 120B (Medium)',
            isDefault: false,
            efforts: []
          },
          {
            id: 'gemini-3.8-flash',
            label: 'Gemini 3.8 Flash',
            isDefault: false,
            efforts: [],
            effortsKnown: false as const
          }
        ]
      }
    }

    const effortValues = (model: string, surface: 'chat' | 'terminal') => {
      const effort = agentPickerEntryOptions(entry, model, surface).find(
        (option) => option.id === 'effort'
      )
      return effort?.kind.type === 'select'
        ? effort.kind.choices.map((choice) => choice.value)
        : null
    }

    for (const surface of ['chat', 'terminal'] as const) {
      expect(effortValues('gemini-4-hydrogen', surface)).toEqual(['low', 'medium', 'high', 'xhigh'])
      expect(effortValues('claude-opus-5-5', surface)).toEqual(['low', 'medium', 'high'])
      expect(effortValues('gemini-pro-orchestrator', surface)).toBeNull()
      expect(effortValues('gpt-oss-120b-medium', surface)).toBeNull()
    }

    // Managed sessions may leave unselected models with effortsKnown: false; terminal falls back to
    // the full static Antigravity effort list while chat only shows confirmed efforts.
    expect(effortValues('gemini-3.8-flash', 'terminal')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    expect(effortValues('gemini-3.8-flash', 'chat')).toBeNull()
  })
})
