// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '../__fixtures__/settings-persistence-test-fixture'
import {
  getDefaultSourceControlAiSettings,
  normalizeSourceControlAiSettings
} from '../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import { liftActionPermissionArgs } from '../../../../../shared/source-control/ai/recipes/source-control-action-permission-lift'
import type { SourceControlActionRecipe } from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import { useSourceControlActionRecipeDraftState } from './source-control-action-recipe-draft-state'

const model = { agentId: 'claude', model: 'sonnet', options: { effort: 'high' } } as const
const initial = normalizeSourceControlAiSettings({
  ...getDefaultSourceControlAiSettings(),
  enabled: true,
  actions: { fixChecks: { agentId: 'claude', agentArgs: '', launchPreferences: model } }
})
it('keeps the global document retryable and preserves a newer document across a pending Save', async () => {
  const recipe = liftActionPermissionArgs<SourceControlActionRecipe>({
    agentId: 'claude' as const,
    agentArgs: '--model opus --effort high'
  })
  const config = { ...initial, actions: { fixChecks: recipe } }
  const writeConfig = vi.fn().mockRejectedValueOnce(new Error('disk refused'))
  const { result } = renderHook(() =>
    useSourceControlActionRecipeDraftState({ config, writeConfig })
  )
  act(() => result.current.onActionTemplateChange('fixChecks', 'mine'))
  await act(async () => {
    await expect(result.current.saveActionTemplateDraft('fixChecks')).rejects.toThrow(
      'disk refused'
    )
  })
  expect(result.current.actionRecipeDraftState.values.fixChecks.argumentChoices).toEqual(
    recipe.argumentChoices
  )
  let finish = () => {}
  writeConfig.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  let save: Promise<void> = Promise.resolve()
  act(() => {
    save = result.current.saveActionTemplateDraft('fixChecks')
  })
  act(() => result.current.onActionAgentArgsChange('fixChecks', '--effort low', true))
  await act(async () => {
    finish()
    await save
  })
  expect(
    result.current.actionRecipeDraftState.values.fixChecks.argumentChoices?.nodes.map(
      (node) => node.text
    )
  ).toEqual(['--model opus', '--effort low'])
  expect(result.current.actionRecipeDraftState.baseValues.fixChecks.argumentChoices).toEqual(
    recipe.argumentChoices
  )
  writeConfig.mockResolvedValue(undefined)
  await act(async () => result.current.saveActionTemplateDraft('fixChecks'))
  expect(result.current.actionRecipeDraftState.values.fixChecks).toEqual(
    result.current.actionRecipeDraftState.baseValues.fixChecks
  )
})
