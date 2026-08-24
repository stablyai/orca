import { describe, expect, it } from 'vitest'
import { planCommitMessageGeneration } from './commit-message-plan'
import { getDefaultSettings } from './constants'
import { resolveSourceControlAiForOperation } from './source-control-ai'
import type { SourceControlAiOperation } from './source-control-ai-types'
import type { GlobalSettings } from './global-settings-types'

const COMPATIBILITY_MODEL_ID = 'github-copilot/gpt-5.4-mini'
const EXPLICIT_MODEL_ID = 'openai-codex/gpt-5.5'

function piSettings(): GlobalSettings {
  const base = getDefaultSettings('/tmp')
  return {
    ...base,
    defaultTuiAgent: 'pi',
    commitMessageAi: {
      ...base.commitMessageAi!,
      agentId: 'pi',
      selectedModelByAgent: {}
    },
    sourceControlAi: {
      ...base.sourceControlAi!,
      agentId: 'pi',
      selectedModelByAgent: {}
    }
  }
}

function resolvePiPlan(
  operation: SourceControlAiOperation,
  configuredModel?: string
): ReturnType<typeof planCommitMessageGeneration> {
  const settings = piSettings()
  if (configuredModel) {
    settings.sourceControlAi!.discoveredModelsByAgent = {
      pi: [{ id: configuredModel, label: 'Configured model' }]
    }
    settings.sourceControlAi!.modelOverridesByOperation = {
      [operation]: { selectedModelByAgent: { pi: configuredModel } }
    }
  }
  const resolved = resolveSourceControlAiForOperation({
    settings,
    repo: null,
    operation,
    discoveryHostKey: 'local'
  })
  expect(resolved.ok).toBe(true)
  if (!resolved.ok) {
    throw new Error(resolved.error)
  }
  return planCommitMessageGeneration(resolved.value.params, 'PROMPT')
}

describe('Pi source-control AI model resolution', () => {
  it.each(['commitMessage', 'pullRequest', 'branchName'] as const)(
    'uses Pi configured default for %s without a model override',
    (operation) => {
      const result = resolvePiPlan(operation)

      expect(result).toMatchObject({ ok: true })
      expect(result.ok && result.plan.args).not.toContain('--model')
      expect(result.ok && result.plan.args).not.toContain(COMPATIBILITY_MODEL_ID)
    }
  )

  it.each(['commitMessage', 'pullRequest', 'branchName'] as const)(
    'uses the migrated Pi default seed for %s',
    (operation) => {
      const settings = piSettings()
      settings.sourceControlAi!.selectedModelByAgent = { pi: COMPATIBILITY_MODEL_ID }
      settings.commitMessageAi!.selectedModelByAgent = { pi: COMPATIBILITY_MODEL_ID }
      settings.piConfiguredDefaultModelState = {
        version: 1,
        defaultsByHost: { local: true },
        commitMessageSeedByHost: {}
      }
      settings.sourceControlAi!.discoveredModelsByAgent = {
        pi: [{ id: COMPATIBILITY_MODEL_ID, label: 'GPT-5.4 mini' }]
      }

      const resolved = resolveSourceControlAiForOperation({
        settings,
        repo: null,
        operation,
        discoveryHostKey: 'local'
      })
      expect(resolved.ok).toBe(true)
      if (!resolved.ok) {
        throw new Error(resolved.error)
      }
      const result = planCommitMessageGeneration(resolved.value.params, 'PROMPT')

      expect(result).toMatchObject({ ok: true })
      expect(result.ok && result.plan.args).not.toContain('--model')
      expect(result.ok && result.plan.args).not.toContain(COMPATIBILITY_MODEL_ID)
    }
  )

  it("preserves an explicit selection of Pi's former compatibility model", () => {
    expect(resolvePiPlan('commitMessage', COMPATIBILITY_MODEL_ID)).toMatchObject({
      ok: true,
      plan: { args: expect.arrayContaining(['--model', COMPATIBILITY_MODEL_ID]) }
    })
  })

  it('preserves a concrete Pi selection before discovery has populated', () => {
    const settings = piSettings()
    settings.sourceControlAi!.selectedModelByAgent = { pi: EXPLICIT_MODEL_ID }
    const resolved = resolveSourceControlAiForOperation({
      settings,
      repo: null,
      operation: 'commitMessage',
      discoveryHostKey: 'local'
    })

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) {
      throw new Error(resolved.error)
    }
    expect(planCommitMessageGeneration(resolved.value.params, 'PROMPT')).toMatchObject({
      ok: true,
      plan: { args: expect.arrayContaining(['--model', EXPLICIT_MODEL_ID]) }
    })
  })

  it.each(['commitMessage', 'pullRequest', 'branchName'] as const)(
    'passes an explicit Pi model override for %s',
    (operation) => {
      expect(resolvePiPlan(operation, EXPLICIT_MODEL_ID)).toMatchObject({
        ok: true,
        plan: { args: expect.arrayContaining(['--model', EXPLICIT_MODEL_ID]) }
      })
    }
  )
})
