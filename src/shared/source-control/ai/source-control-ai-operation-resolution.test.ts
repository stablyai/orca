import { describe, expect, it } from 'vitest'
import { resolveSourceControlAiForOperation } from './source-control-ai-operation-resolution'
import { getDefaultSourceControlAiSettings } from './settings/source-control-ai-settings'
import type { SourceControlAiSettings } from './settings/source-control-ai-settings-types'

function resolveCodexModel(overrides: Partial<SourceControlAiSettings>): string | undefined {
  const result = resolveSourceControlAiForOperation({
    settings: {
      defaultTuiAgent: 'codex',
      sourceControlAi: {
        ...getDefaultSourceControlAiSettings(),
        discoveredModelsByAgent: {
          codex: [
            { id: 'proxy/fast', label: 'Fast' },
            { id: 'proxy/deep', label: 'Deep' }
          ]
        },
        ...overrides
      }
    },
    operation: 'branchName'
  })
  return result.ok ? result.value.params.model : undefined
}

describe('resolveSourceControlAiForOperation model fallback', () => {
  it('runs a model the CLI listed when the listing lacks the built-in default', () => {
    expect(resolveCodexModel({})).toBe('proxy/fast')
  })

  it('replaces a saved pick the CLI no longer lists', () => {
    expect(resolveCodexModel({ selectedModelByAgent: { codex: 'proxy/retired' } })).toBe(
      'proxy/fast'
    )
  })

  it('replaces a saved built-in pick the CLI does not list', () => {
    expect(resolveCodexModel({ selectedModelByAgent: { codex: 'gpt-5.5' } })).toBe('proxy/fast')
  })
})
