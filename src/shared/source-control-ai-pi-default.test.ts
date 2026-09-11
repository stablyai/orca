import {
  migratePiConfiguredDefaultModelState,
  applyPiConfiguredDefaultSelectionUpdate
} from './pi-configured-default-model-state'
import {
  projectSourceControlAiToLegacyCommitMessageAi,
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  resolveSourceControlAiForOperation
} from './source-control-ai'
import { describe, expect, it } from 'vitest'
import { planCommitMessageGeneration } from './commit-message-plan'
import { getDefaultSettings } from './constants'
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

describe('Pi configured default settings roundtrip', () => {
  it.each(['local', 'ssh:fixture', 'wsl:Ubuntu'])(
    'preserves explicit choices and default selection on %s',
    (hostKey) => {
      let settings = piSettings()
      const explicit = structuredClone(settings.sourceControlAi!)
      explicit.selectedModelByAgentByHost = { [hostKey]: { pi: COMPATIBILITY_MODEL_ID } }
      const migration = migratePiConfiguredDefaultModelState({
        sourceControlAi: explicit,
        commitMessageAi: null,
        persistedState: undefined
      })
      expect(migration.state.defaultsByHost[hostKey]).toBeUndefined()
      const selectedDefault = structuredClone(explicit)
      selectedDefault.selectedModelByAgentByHost![hostKey]!.pi = 'default'
      let state = applyPiConfiguredDefaultSelectionUpdate({
        previous: explicit,
        next: selectedDefault,
        state: migration.state
      })
      expect(selectedDefault.selectedModelByAgentByHost![hostKey]!.pi).toBe('default')
      const legacy = projectSourceControlAiToLegacyCommitMessageAi(selectedDefault)
      expect(legacy.selectedModelByAgentByHost![hostKey]!.pi).toBe(COMPATIBILITY_MODEL_ID)
      const reloaded = mergeLegacyCommitMessageAiIntoSourceControlAi(selectedDefault, legacy)
      settings = {
        ...settings,
        sourceControlAi: reloaded,
        commitMessageAi: legacy,
        piConfiguredDefaultModelState: state
      }
      for (const operation of ['commitMessage', 'pullRequest', 'branchName'] as const) {
        const result = resolveSourceControlAiForOperation({
          settings,
          operation,
          discoveryHostKey: hostKey
        })
        expect(result.ok && result.value.params.useConfiguredDefaultModel).toBe(true)
      }
      state = applyPiConfiguredDefaultSelectionUpdate({ previous: reloaded, next: explicit, state })
      expect(state.defaultsByHost[hostKey]).toBeUndefined()
      settings.sourceControlAi = explicit
      settings.piConfiguredDefaultModelState = state
      const result = resolveSourceControlAiForOperation({
        settings,
        operation: 'commitMessage',
        discoveryHostKey: hostKey
      })
      expect(result.ok && result.value.params.useConfiguredDefaultModel).toBeUndefined()
      expect(result.ok && result.value.params.model).toBe(COMPATIBILITY_MODEL_ID)
    }
  )
  it.each(['commitMessage', 'pullRequest', 'branchName'] as const)(
    'preserves operation default through reload for %s',
    (operation) => {
      const settings = piSettings()
      settings.sourceControlAi!.modelOverridesByOperation = {
        [operation]: { selectedModelByAgent: { pi: 'default' } }
      }
      const migration = migratePiConfiguredDefaultModelState({
        sourceControlAi: settings.sourceControlAi!,
        commitMessageAi: settings.commitMessageAi,
        persistedState: undefined
      })
      settings.piConfiguredDefaultModelState = migration.state
      const result = resolveSourceControlAiForOperation({ settings, operation })
      expect(result.ok && result.value.params.useConfiguredDefaultModel).toBe(true)
    }
  )
})
