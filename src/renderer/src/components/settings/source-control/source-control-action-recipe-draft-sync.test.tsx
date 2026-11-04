// @vitest-environment happy-dom
import { act, fireEvent, renderHook, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import {
  getDefaultSourceControlAiSettings,
  normalizeSourceControlAiSettings
} from '../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import type {
  SourceControlAiSettings,
  SourceControlAiSettingsPatch
} from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { useSourceControlActionRecipeDraftState } from './source-control-action-recipe-draft-state'
import { renderGlobalCommitCard } from '../__fixtures__/global-commit-card-test-fixture'
import { persist } from '../__fixtures__/settings-persistence-test-fixture'

const initial = (): SourceControlAiSettings => ({
  ...getDefaultSourceControlAiSettings(),
  enabled: true,
  actions: {
    commitMessage: {
      agentId: 'codex',
      agentArgs: '--base',
      commandInputTemplate: 'base {basePrompt}'
    }
  },
  modelOverridesByOperation: { commitMessage: { selectedModelByAgent: { codex: 'gpt-5.4' } } }
})

function withModel(config: SourceControlAiSettings, model: string): SourceControlAiSettings {
  return {
    ...config,
    modelOverridesByOperation: { commitMessage: { selectedModelByAgent: { codex: model } } }
  }
}

function withRecipe(config: SourceControlAiSettings, agentArgs: string): SourceControlAiSettings {
  return {
    ...config,
    actions: {
      ...config.actions,
      commitMessage: {
        ...config.actions?.commitMessage,
        agentArgs,
        commandInputTemplate: `${agentArgs} {basePrompt}`
      }
    }
  }
}

function renderDraft(config: SourceControlAiSettings) {
  return renderHook(
    ({ config }) => useSourceControlActionRecipeDraftState({ config, writeConfig: async () => {} }),
    { initialProps: { config } }
  )
}

it('a reverted draft stays clean and follows a later external recipe after a model save', () => {
  let config = initial()
  const view = renderDraft(config)
  act(() => view.result.current.onActionAgentArgsChange('commitMessage', '--draft'))
  config = withModel(config, 'gpt-5.5')
  view.rerender({ config })
  act(() => view.result.current.onActionAgentArgsChange('commitMessage', '--base'))
  config = withRecipe(config, '--new-external')
  view.rerender({ config })
  const { values, baseValues } = view.result.current.actionRecipeDraftState
  expect(values.commitMessage.agentArgs).toBe('--new-external')
  expect(values.commitMessage.commandInputTemplate).toBe('--new-external {basePrompt}')
  expect(values.commitMessage).toEqual(baseValues.commitMessage)
})

it('a clean card follows one external save that changes both the model and the recipe', () => {
  let config = initial()
  const view = renderDraft(config)
  act(() => view.result.current.onActionAgentArgsChange('commitMessage', '--draft'))
  config = withModel(config, 'gpt-5.5')
  view.rerender({ config })
  act(() => view.result.current.onActionAgentArgsChange('commitMessage', '--base'))
  config = withRecipe(withModel(config, 'gpt-5.6'), '--new-external')
  view.rerender({ config })
  const { values, baseValues } = view.result.current.actionRecipeDraftState
  expect(values.commitMessage.agentArgs).toBe('--new-external')
  expect(values.commitMessage.modelChoice?.selectedModelByAgent?.codex).toBe('gpt-5.6')
  expect(values.commitMessage).toEqual(baseValues.commitMessage)
})

it('the first render after another editor saves a model shows it and keeps dirty Arguments', () => {
  let config = initial()
  const frames: { model: string | undefined; args: string | undefined }[] = []
  const view = renderHook(
    ({ config }) => {
      const value = useSourceControlActionRecipeDraftState({ config, writeConfig: async () => {} })
      const row = value.actionRecipeDraftState.values.commitMessage
      frames.push({ model: row.modelChoice?.selectedModelByAgent?.codex, args: row.agentArgs })
      return value
    },
    { initialProps: { config } }
  )
  act(() => view.result.current.onActionAgentArgsChange('commitMessage', '--draft'))
  frames.length = 0
  config = withModel(config, 'gpt-5.5')
  view.rerender({ config })
  expect(frames[0]).toEqual({ model: 'gpt-5.5', args: '--draft' })
})

it.each([false, true])(
  'Save after another editor saves a model keeps keystrokes typed while it ran: %s',
  async (typedDuringSave) => {
    let config = initial()
    let release = (): void => {}
    let emitted: Partial<SourceControlAiSettings> | undefined
    const writeConfig = async (patch: SourceControlAiSettingsPatch): Promise<void> => {
      emitted = typeof patch === 'function' ? patch(config) : patch
      await new Promise<void>((resolve) => (release = resolve))
      config = { ...config, ...emitted }
    }
    const view = renderHook(
      ({ config }) => useSourceControlActionRecipeDraftState({ config, writeConfig }),
      { initialProps: { config } }
    )
    act(() => view.result.current.onActionAgentArgsChange('commitMessage', '--submitted'))
    config = withModel(config, 'gpt-5.5')
    view.rerender({ config })
    let saving: Promise<void> | undefined
    act(() => {
      saving = view.result.current.saveActionTemplateDraft('commitMessage')
    })
    expect(emitted).not.toHaveProperty('modelOverridesByOperation')
    if (typedDuringSave) {
      act(() => view.result.current.onActionAgentArgsChange('commitMessage', '--newer'))
    }
    await act(async () => {
      release()
      await saving
    })
    view.rerender({ config })
    const { values, baseValues } = view.result.current.actionRecipeDraftState
    expect(values.commitMessage.agentArgs).toBe(typedDuringSave ? '--newer' : '--submitted')
    expect(values.commitMessage.modelChoice?.selectedModelByAgent?.codex).toBe('gpt-5.5')
    if (!typedDuringSave) {
      expect(values.commitMessage).toEqual(baseValues.commitMessage)
    }
  }
)

it('the global card does not revive reverted Arguments over a later external recipe', async () => {
  const card = renderGlobalCommitCard(initial())
  const external = (next: (config: SourceControlAiSettings) => SourceControlAiSettings) =>
    act(() =>
      useAppStore.setState(({ settings }) => ({
        settings: settings && {
          ...settings,
          sourceControlAi: normalizeSourceControlAiSettings(next(settings.sourceControlAi!))
        }
      }))
    )
  fireEvent.change(card.row.getByDisplayValue('--base'), { target: { value: '--draft' } })
  external((config) => withModel(config, 'gpt-5.5'))
  fireEvent.change(card.row.getByDisplayValue('--draft'), { target: { value: '--base' } })
  expect(card.row.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  external((config) => withRecipe(config, '--new-external'))
  await waitFor(() => expect(card.row.queryByDisplayValue('--new-external')).not.toBeNull())
  expect(card.row.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  expect(persist).not.toHaveBeenCalled()
  expect(useAppStore.getState().settings?.sourceControlAi?.actions?.commitMessage?.agentArgs).toBe(
    '--new-external'
  )
})
