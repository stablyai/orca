import { describe, expect, it } from 'vitest'
import { resolveSourceControlAiForOperation } from './source-control-ai-operation-resolution'
import { getDefaultSourceControlAiSettings } from './settings/source-control-ai-settings'
import type { CommitMessageAiModelCapability } from './generation/commit-message-ai-types'
import type { SourceControlAiSettings } from './settings/source-control-ai-settings-types'

// A ChatGPT-account Codex listing: no gpt-5.5 or gpt-5.4-mini, which the built-in rows still carry.
const ACCOUNT_LISTING: CommitMessageAiModelCapability[] = [
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', isDefault: true }
]

function resolveCodexModel(settings: Partial<SourceControlAiSettings>): string | undefined {
  const resolved = resolveSourceControlAiForOperation({
    settings: {
      sourceControlAi: {
        ...getDefaultSourceControlAiSettings(),
        agentId: 'codex',
        discoveredModelsByAgentByHost: { local: { codex: ACCOUNT_LISTING } },
        ...settings
      }
    },
    operation: 'branchName'
  })
  return resolved.ok ? resolved.value.params.model : undefined
}

describe('resolveSourceControlAiForOperation with an account model listing', () => {
  it('never runs a Codex model the signed-in account does not list', () => {
    // A saved global pick from an older build that the account cannot run.
    expect(resolveCodexModel({ selectedModelByAgent: { codex: 'gpt-5.5' } })).toBe('gpt-6-luna')
    // An unrunnable per-action pick falls through to a runnable global pick.
    expect(
      resolveCodexModel({
        selectedModelByAgent: { codex: 'gpt-6.1-terra' },
        modelOverridesByOperation: { branchName: { selectedModelByAgent: { codex: 'gpt-5.5' } } }
      })
    ).toBe('gpt-6.1-terra')
  })
})
