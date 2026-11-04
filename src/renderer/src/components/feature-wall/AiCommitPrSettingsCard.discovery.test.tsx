// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '../ui/tooltip'
import { persist } from '../settings/__fixtures__/settings-persistence-test-fixture'
import { AiCommitPrSettingsCard } from './AiCommitPrSettingsCard'
import { useAiCommitPrSettings } from './useAiCommitPrSettings'
import * as picker from './ai-commit-pr-picker'
import * as models from '../../../../shared/source-control-ai-model-selection'
import * as sourceSettings from '../../../../shared/source-control-ai'

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

it.each([10, 100])('bounds catalog work on command edits with %i remote models', async (size) => {
  const settings = useAppStore.getState().settings!
  useAppStore.setState({
    settings: {
      ...settings,
      commitMessageAi: {
        enabled: true,
        agentId: 'custom',
        selectedModelByAgent: { codex: 'gpt-5.5' },
        selectedThinkingByModel: {},
        customPrompt: '',
        customAgentCommand: 'writer',
        discoveredModelsByAgentByHost: {
          remote: {
            codex: Array.from({ length: size }, (_, i) => ({
              id: `remote-${i}`,
              label: `Remote ${i}`
            }))
          }
        }
      }
    }
  })
  const normalize = vi.spyOn(sourceSettings, 'normalizeSourceControlAiSettings')
  const catalog = vi.spyOn(models, 'getTextGenerationModels')
  const entries = vi.spyOn(picker, 'aiCommitPrPickerEntry')
  const view = renderHook(() => useAiCommitPrSettings())
  normalize.mockClear()
  catalog.mockClear()
  entries.mockClear()
  await act(async () => view.result.current.writeConfig({ customAgentCommand: 'writer --new' }))
  expect(normalize).not.toHaveBeenCalled()
  expect(catalog).not.toHaveBeenCalled()
  expect(entries).not.toHaveBeenCalled()
  act(() =>
    useAppStore.setState(({ settings }) => ({
      settings: {
        ...settings!,
        commitMessageAi: {
          ...settings!.commitMessageAi!,
          discoveredModelsByAgent: {
            codex: [{ id: 'local-model', label: 'Local model' }]
          }
        }
      }
    }))
  )
  expect(
    view.result.current.pickerEntries.find((entry) => entry.agent === 'codex')?.catalog
  ).toMatchObject({
    models: expect.arrayContaining([
      {
        id: 'local-model',
        label: 'Local model',
        isDefault: false,
        efforts: [],
        defaultEffort: undefined
      }
    ])
  })
  expect(catalog.mock.calls.length).toBeGreaterThan(0)
  expect(entries.mock.calls.length).toBeGreaterThan(0)
  catalog.mockClear()
  entries.mockClear()
  await act(async () =>
    view.result.current.writeConfig({ selectedModelByAgent: { codex: 'local-model' } })
  )
  expect(
    view.result.current.pickerEntries.find((entry) => entry.agent === 'codex')?.terminal.model
  ).toBe('local-model')
  expect(catalog).not.toHaveBeenCalled()
  expect(entries.mock.calls.length).toBeGreaterThan(0)
})
