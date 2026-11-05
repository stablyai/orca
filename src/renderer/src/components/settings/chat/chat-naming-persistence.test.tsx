// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { setSourceControlActionDefault } from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import {
  getDefaultSourceControlAiSettings,
  normalizeSourceControlAiSettings
} from '../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import type {
  SourceControlAiSettings,
  SourceControlAiSettingsPatch
} from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { useSourceControlActionRecipeDraftState } from '../source-control/source-control-action-recipe-draft-state'
import { useAppStore } from '../../../store/index'
import { useSettingsInteractionController } from '../page/use-settings-interaction-controller'
import { persist, settingsModel } from '../__fixtures__/settings-persistence-test-fixture'

it('retains the legacy Git failure contract and composes later queued naming writes', async () => {
  const previousBranch = normalizeSourceControlAiSettings(
    useAppStore.getState().settings?.sourceControlAi
  ).actions?.branchName
  persist.mockRejectedValueOnce(new Error('Settings disk is unavailable'))
  const { result } = renderHook(() => useSettingsInteractionController(settingsModel()))
  await act(async () => {
    const failed = result.current.writeSourceControlAiSettings((current) => ({
      actions: setSourceControlActionDefault(current.actions, 'branchName', {
        commandInputTemplate: 'Must not persist'
      })
    }))
    const settled = expect(failed).resolves.toBeUndefined()
    const agent = result.current.writeSourceControlAiSettingsOrThrow((current) => ({
      actions: setSourceControlActionDefault(current.actions, 'conversationName', {
        agentId: 'codex'
      })
    }))
    const recipe = result.current.writeSourceControlAiSettingsOrThrow((current) => ({
      actions: setSourceControlActionDefault(current.actions, 'conversationName', {
        agentArgs: '--model fast',
        commandInputTemplate: 'Name {firstPrompt}'
      })
    }))
    await Promise.all([settled, agent, recipe])
  })
  expect(useAppStore.getState().settings?.sourceControlAi).toMatchObject({
    enabled: false,
    actions: {
      commitMessage: { commandInputTemplate: 'Keep the Git recipe' },
      conversationName: {
        agentId: 'codex',
        agentArgs: '--model fast',
        commandInputTemplate: 'Name {firstPrompt}'
      }
    }
  })
  expect(useAppStore.getState().settings?.sourceControlAi?.actions?.branchName).toEqual(
    previousBranch
  )
  expect(persist).toHaveBeenCalledTimes(3)
})

it('saving only Arguments keeps a newer model choice saved by another editor', async () => {
  let current: SourceControlAiSettings = {
    ...getDefaultSourceControlAiSettings(),
    agentId: 'codex',
    modelOverridesByOperation: { commitMessage: { selectedModelByAgent: { codex: 'gpt-5.4' } } }
  }
  const writeConfig = async (patch: SourceControlAiSettingsPatch) => {
    current = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) }
  }
  const view = renderHook(
    ({ config }) => useSourceControlActionRecipeDraftState({ config, writeConfig }),
    { initialProps: { config: current } }
  )
  act(() => view.result.current.onActionAgentArgsChange('commitMessage', '--verbose'))
  current = {
    ...current,
    modelOverridesByOperation: { commitMessage: { selectedModelByAgent: { codex: 'gpt-5.5' } } }
  }
  view.rerender({ config: current })
  await act(() => view.result.current.saveActionTemplateDraft('commitMessage'))
  expect(current.actions?.commitMessage?.agentArgs).toBe('--verbose')
  expect(current.modelOverridesByOperation?.commitMessage?.selectedModelByAgent?.codex).toBe(
    'gpt-5.5'
  )
})
