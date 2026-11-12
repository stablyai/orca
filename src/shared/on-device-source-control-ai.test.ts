import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import { resolveSourceControlAiForOperation } from './source-control/ai/source-control-ai-operation-resolution'
import {
  ON_DEVICE_TEXT_GENERATION_ID,
  ON_DEVICE_TEXT_GENERATION_MODEL_ID
} from './on-device-text-generation'
import type { GlobalSettings } from './global-settings-types'

function settingsWith(overrides: Record<string, unknown>): GlobalSettings {
  const base = getDefaultSettings('/tmp')
  return {
    ...base,
    defaultTuiAgent: 'codex' as const,
    sourceControlAi: {
      ...base.sourceControlAi!,
      enabled: true,
      agentId: ON_DEVICE_TEXT_GENERATION_ID,
      ...overrides
    }
  }
}

function resolve(settings: GlobalSettings, operation: 'commitMessage' | 'branchName') {
  return resolveSourceControlAiForOperation({
    settings,
    repo: null,
    operation,
    discoveryHostKey: 'local',
    prCreationProductDefaults: {
      draft: false,
      useTemplate: false,
      generateDetailsOnOpen: false,
      openAfterCreate: false
    }
  })
}

describe('on-device source control resolution', () => {
  it('resolves the provider with its single model instead of a CLI agent', () => {
    const result = resolve(settingsWith({}), 'commitMessage')

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.value.params.agentId).toBe(ON_DEVICE_TEXT_GENERATION_ID)
    expect(result.value.params.model).toBe(ON_DEVICE_TEXT_GENERATION_MODEL_ID)
  })

  it('keeps user instructions as the session instructions', () => {
    const result = resolve(
      settingsWith({ instructionsByOperation: { commitMessage: 'Write short subjects.' } }),
      'commitMessage'
    )

    expect(result.ok && result.value.params.customPrompt).toContain('Write short subjects.')
  })

  it('still refuses an empty command template: it is the prompt skeleton', () => {
    const result = resolve(
      settingsWith({ actions: { commitMessage: { commandInputTemplate: '  ' } } }),
      'commitMessage'
    )

    expect(result).toMatchObject({ ok: false, errorCode: 'commandTemplateEmptyCommitMessage' })
  })
})
