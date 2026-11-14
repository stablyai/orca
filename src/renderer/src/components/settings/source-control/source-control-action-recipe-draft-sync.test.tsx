// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'

import { getDefaultSourceControlAiSettings } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import type { SourceControlAiSettings } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { useSourceControlActionRecipeDraftState } from './source-control-action-recipe-draft-state'

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
