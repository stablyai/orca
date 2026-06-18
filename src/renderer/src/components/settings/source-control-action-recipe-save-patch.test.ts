import { describe, expect, it } from 'vitest'
import {
  getDefaultSourceControlAiSettings,
  normalizeSourceControlAiSettings
} from '../../../../shared/source-control-ai'
import type { SourceControlAiSettings } from '../../../../shared/source-control-ai-types'
import type { CommitMessageAiSettings } from '../../../../shared/types'
import { buildActionRecipeSavePatch } from './source-control-action-recipe-save-patch'

const KOREAN_INSTRUCTION = '모든 커밋 메시지는 반드시 한국어로 작성한다.'

function settingsWithLegacyCommitInstruction(): {
  config: SourceControlAiSettings
  legacy: CommitMessageAiSettings
} {
  const base = getDefaultSourceControlAiSettings()
  return {
    config: {
      ...base,
      actions: {
        ...base.actions,
        commitMessage: {
          agentId: 'claude',
          commandInputTemplate: `{basePrompt}\n\n${KOREAN_INSTRUCTION}`,
          agentArgs: '--model sonnet'
        }
      },
      instructionsByOperation: {
        ...base.instructionsByOperation,
        commitMessage: KOREAN_INSTRUCTION
      }
    },
    // Why: oldest legacy storage still holds the same prompt and is the
    // migration fallback that normalize would otherwise re-inject.
    legacy: {
      enabled: true,
      agentId: 'claude',
      selectedModelByAgent: {},
      selectedThinkingByModel: {},
      customPrompt: KOREAN_INSTRUCTION,
      customAgentCommand: ''
    }
  }
}

describe('buildActionRecipeSavePatch', () => {
  it('lets a reduced commit template stay at the default after the read-back normalize', () => {
    const { config, legacy } = settingsWithLegacyCommitInstruction()

    const patch = buildActionRecipeSavePatch(config, 'commitMessage', {
      commandInputTemplate: '{basePrompt}',
      agentArgs: '--model sonnet'
    })
    const persisted = normalizeSourceControlAiSettings({ ...config, ...patch }, legacy)

    expect(persisted.actions?.commitMessage?.commandInputTemplate).toBe('{basePrompt}')
    expect(patch.instructionsByOperation?.commitMessage).toBe('')
  })

  it('keeps a non-default commit template and still retires the stale instruction', () => {
    const { config, legacy } = settingsWithLegacyCommitInstruction()

    const patch = buildActionRecipeSavePatch(config, 'commitMessage', {
      commandInputTemplate: '{basePrompt}\n\nUse Conventional Commits.',
      agentArgs: ''
    })
    const persisted = normalizeSourceControlAiSettings({ ...config, ...patch }, legacy)

    expect(persisted.actions?.commitMessage?.commandInputTemplate).toBe(
      '{basePrompt}\n\nUse Conventional Commits.'
    )
    expect(patch.instructionsByOperation?.commitMessage).toBe('')
  })

  it('persists the CLI arguments alongside the template', () => {
    const base = getDefaultSourceControlAiSettings()

    const patch = buildActionRecipeSavePatch(base, 'commitMessage', {
      commandInputTemplate: '{basePrompt}',
      agentArgs: '--model opus'
    })

    expect(patch.actions?.commitMessage).toMatchObject({
      commandInputTemplate: '{basePrompt}',
      agentArgs: '--model opus'
    })
  })

  it('does not touch instructionsByOperation for launch actions', () => {
    const base = getDefaultSourceControlAiSettings()

    const patch = buildActionRecipeSavePatch(base, 'fixChecks', {
      commandInputTemplate: '{basePrompt}\n\nFix the checks.',
      agentArgs: ''
    })

    expect(patch.actions?.fixChecks?.commandInputTemplate).toBe('{basePrompt}\n\nFix the checks.')
    expect(patch.instructionsByOperation).toBeUndefined()
  })
})
