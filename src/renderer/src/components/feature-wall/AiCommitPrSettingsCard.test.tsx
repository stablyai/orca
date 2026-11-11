// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '../ui/tooltip'
import { persist } from '../settings/__fixtures__/settings-persistence-test-fixture'
import { AiCommitPrSettingsCard } from './AiCommitPrSettingsCard'
import { useAiCommitPrSettings } from './useAiCommitPrSettings'
import { aiCommitPrPickerDraft } from './ai-commit-pr-picker'
import { applyAgentPickerEdit } from '../../../../shared/agent-launch/picker/agent-launch-picker-edits'

it('uses the shared AI-author picker without saving on cancel and preserves Custom command', async () => {
  const settings = useAppStore.getState().settings!
  useAppStore.setState({
    settings: {
      ...settings,
      commitMessageAi: {
        enabled: true,
        agentId: 'codex',
        selectedModelByAgent: { codex: 'gpt-5.5' },
        selectedThinkingByModel: { 'gpt-5.5': 'high' },
        customPrompt: 'Keep prompt',
        customAgentCommand: 'writer {prompt}'
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
  fireEvent.click(screen.getByRole('option', { name: /^Legacy models/ }))
  fireEvent.click(screen.getByRole('option', { name: 'GPT-5.4' }))
  fireEvent.keyDown(screen.getByLabelText('Search models'), { key: 'Escape' })
  fireEvent.keyDown(screen.getByPlaceholderText('Search, e.g. Opus 5.5…'), {
    key: 'Escape'
  })
  expect(persist).not.toHaveBeenCalled()
  expect(useAppStore.getState().settings?.commitMessageAi?.selectedModelByAgent.codex).toBe(
    'gpt-5.5'
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), {
    button: 0,
    ctrlKey: false
  })
  fireEvent.click(screen.getByRole('button', { name: 'Configure Codex' }))
  fireEvent.click(screen.getByRole('option', { name: /^Legacy models/ }))
  fireEvent.click(screen.getByRole('option', { name: 'GPT-5.4' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Low' }))
  fireEvent.click(screen.getByRole('button', { name: /^Use$/ }))
  await waitFor(() =>
    expect(useAppStore.getState().settings?.commitMessageAi).toMatchObject({
      selectedModelByAgent: { codex: 'gpt-5.4' },
      selectedThinkingByModel: { 'gpt-5.4': 'low', 'gpt-5.5': 'high' }
    })
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), {
    button: 0,
    ctrlKey: false
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Custom' }))
  expect(await screen.findByRole('textbox', { name: 'Custom command' })).toHaveProperty(
    'value',
    'writer {prompt}'
  )
  expect(useAppStore.getState().settings?.commitMessageAi).toMatchObject({
    agentId: 'custom',
    customPrompt: 'Keep prompt',
    selectedModelByAgent: { codex: 'gpt-5.4' }
  })
})

it('keys an accepted effort to its displayed model while preserving a newer selected model', async () => {
  const settings = useAppStore.getState().settings!
  useAppStore.setState({
    settings: {
      ...settings,
      commitMessageAi: {
        enabled: true,
        agentId: 'codex',
        selectedModelByAgent: { codex: 'gpt-5.5' },
        selectedThinkingByModel: { 'gpt-5.5': 'high', 'gpt-5.4': 'medium' },
        customPrompt: '',
        customAgentCommand: ''
      }
    }
  })
  const view = renderHook(() => useAiCommitPrSettings())
  const entry = view.result.current.pickerEntries.find((entry) => entry.agent === 'codex')!
  const draft = applyAgentPickerEdit(entry, aiCommitPrPickerDraft(entry), {
    kind: 'choice',
    patch: { options: { effort: 'low' } }
  })
  const accept = view.result.current.onPick
  act(() =>
    useAppStore.setState(({ settings }) => ({
      settings: {
        ...settings!,
        commitMessageAi: {
          ...settings!.commitMessageAi!,
          selectedModelByAgent: { codex: 'gpt-5.4' }
        }
      }
    }))
  )
  act(() => accept('codex', draft))
  await waitFor(() => expect(persist).toHaveBeenCalledOnce())
  expect(useAppStore.getState().settings?.commitMessageAi).toMatchObject({
    selectedModelByAgent: { codex: 'gpt-5.4' },
    selectedThinkingByModel: { 'gpt-5.5': 'low', 'gpt-5.4': 'medium' }
  })
})
