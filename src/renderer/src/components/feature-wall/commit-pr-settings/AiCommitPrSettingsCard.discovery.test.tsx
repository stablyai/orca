// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import { TooltipProvider } from '../../ui/tooltip'
import { persist } from '../../settings/__fixtures__/settings-persistence-test-fixture'
import { AiCommitPrSettingsCard } from './AiCommitPrSettingsCard'

import * as models from '../../../../../shared/source-control/ai/settings/source-control-ai-model-selection'

it.each(['omitted', 'efforts replaced'])(
  'keeps accepted choices when discovery is %s',
  async (change) => {
    const settings = useAppStore.getState().settings!
    useAppStore.setState({
      settings: {
        ...settings,
        commitMessageAi: {
          enabled: true,
          agentId: 'codex',
          selectedModelByAgent: { codex: 'gpt-5.5' },
          selectedThinkingByModel: {},
          customPrompt: '',
          customAgentCommand: '',
          discoveredModelsByAgent: {
            codex: [
              {
                id: 'gpt-6.1-sol',
                label: 'GPT-6.1 Sol',
                defaultThinkingLevel: 'low',
                thinkingLevels: [
                  { id: 'low', label: 'Low' },
                  { id: 'high', label: 'High' }
                ]
              }
            ]
          }
        }
      }
    })
    render(
      <TooltipProvider>
        <AiCommitPrSettingsCard />
      </TooltipProvider>
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(screen.getByRole('button', { name: 'Configure Codex' }))
    fireEvent.click(screen.getByRole('option', { name: 'GPT-6.1 Sol' }))
    fireEvent.click(screen.getByRole('radio', { name: 'High' }))
    act(() =>
      useAppStore.setState(({ settings }) => ({
        settings: {
          ...settings!,
          commitMessageAi: { ...settings!.commitMessageAi!, customPrompt: 'A newer instruction' },
          sourceControlAi: {
            ...settings!.sourceControlAi!,
            ...models.withDiscoveredModels(
              settings!.sourceControlAi!,
              'codex',
              change === 'omitted'
                ? [{ id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' }]
                : [
                    {
                      id: 'gpt-6.1-sol',
                      label: 'GPT-6.1 Sol',
                      defaultThinkingLevel: 'low',
                      thinkingLevels: [{ id: 'low', label: 'Low' }]
                    }
                  ],
              'local'
            )
          }
        }
      }))
    )
    expect(persist).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Use$/ }))
    await waitFor(() => expect(persist).toHaveBeenCalledOnce())
    expect(useAppStore.getState().settings?.commitMessageAi).toMatchObject({
      selectedModelByAgent: { codex: 'gpt-6.1-sol' },
      selectedThinkingByModel: { 'gpt-6.1-sol': 'high' },
      customPrompt: 'A newer instruction'
    })
  }
)
