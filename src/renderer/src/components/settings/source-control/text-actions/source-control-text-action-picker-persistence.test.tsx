// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { normalizeSourceControlAiSettings } from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import { useAppStore } from '../../../../store/index'
import { persist, settingsModel } from '../../__fixtures__/settings-persistence-test-fixture'
import { ChatPersistenceHarness } from '../../__fixtures__/chat-persistence-harness-test-fixture'
import { renderGlobalCommitCard } from '../../__fixtures__/global-commit-card-test-fixture'

it('keeps inherited Chat naming unbound through configured Use, Discard and Save', async () => {
  const settings = useAppStore.getState().settings!
  const choice = { selectedModelByAgent: { claude: 'haiku' } }
  useAppStore.setState({
    repos: [],
    settings: {
      ...settings,
      defaultTuiAgent: 'codex',
      sourceControlAi: normalizeSourceControlAiSettings({
        ...normalizeSourceControlAiSettings(settings.sourceControlAi),
        actions: { conversationName: { agentId: null, agentArgs: '' } },
        modelOverridesByOperation: { conversationName: choice }
      })
    }
  })
  render(<ChatPersistenceHarness model={settingsModel()} />)
  fireEvent.click(
    within(document.getElementById('chat-names')!).getByRole('button', { name: 'Advanced' })
  )
  const source = () => useAppStore.getState().settings!.sourceControlAi!
  const open = (agent = 'Codex') => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), { button: 0 })
    fireEvent.click(screen.getByRole('button', { name: `Configure ${agent}` }))
  }
  open()
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  expect(persist).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)

  open()
  fireEvent.click(screen.getByRole('option', { name: 'GPT-5.4' }))
  fireEvent.click(screen.getByRole('radio', { name: 'High' }))
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  expect(persist).not.toHaveBeenCalled()
  expect(source().actions?.conversationName?.agentId).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
  expect(source().modelOverridesByOperation?.conversationName).toEqual(choice)
  expect(source().actions?.conversationName?.agentId).toBeNull()

  open()
  fireEvent.click(screen.getByRole('option', { name: 'GPT-5.4' }))
  fireEvent.click(screen.getByRole('radio', { name: 'High' }))
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  expect(source().actions?.conversationName?.agentId).toBeNull()
  expect(source().modelOverridesByOperation?.conversationName).toMatchObject({
    selectedModelByAgent: { claude: 'haiku', codex: 'gpt-5.4' },
    selectedThinkingByModel: { 'gpt-5.4': 'high' }
  })

  open('Claude')
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  await waitFor(() => expect(source().actions?.conversationName?.agentId).toBe('claude'))
  expect(persist).toHaveBeenCalledTimes(2)
})

it('a plain Chat naming row explicitly binds the inherited agent', async () => {
  const settings = useAppStore.getState().settings!
  useAppStore.setState({
    settings: {
      ...settings,
      defaultTuiAgent: 'codex',
      sourceControlAi: normalizeSourceControlAiSettings({
        ...normalizeSourceControlAiSettings(settings.sourceControlAi),
        actions: { conversationName: { agentId: null, agentArgs: '' } }
      })
    }
  })
  render(<ChatPersistenceHarness model={settingsModel()} />)
  fireEvent.click(
    within(document.getElementById('chat-names')!).getByRole('button', { name: 'Advanced' })
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), { button: 0 })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }))
  await waitFor(() =>
    expect(
      useAppStore.getState().settings?.sourceControlAi?.actions?.conversationName?.agentId
    ).toBe('codex')
  )
  expect(persist).toHaveBeenCalledTimes(1)
})

it('keeps unrelated delimiterless config operands when a text Model is picked and saved', async () => {
  const agentArgs = '-c models --config model_reasoning_efforts --verbose'
  const card = renderGlobalCommitCard({
    actions: { commitMessage: { agentId: 'codex', agentArgs } }
  })
  card.open('Codex')
  expect(screen.queryByText('Set by your Arguments')).toBeNull()
  fireEvent.click(screen.getByRole('option', { name: 'GPT-5.4' }))
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  const saved = (await card.save()).sourceControlAi
  expect(saved?.actions?.commitMessage?.agentArgs).toBe(agentArgs)
  expect(saved?.modelOverridesByOperation?.commitMessage?.selectedModelByAgent?.codex).toBe(
    'gpt-5.4'
  )
})

it('discovers the current text agent on reopen and live changes without relisting an open setup', async () => {
  const requests: string[] = []
  const list = vi.fn(async ({ agentId }: { agentId: string }) => {
    requests.push(agentId)
    return { success: true, models: [{ id: `${agentId}-fresh`, label: `${agentId} fresh` }] }
  })
  Object.assign(window.api, { git: { discoverCommitMessageModels: list } })
  const card = renderGlobalCommitCard({ actions: { commitMessage: { agentId: 'claude' } } })
  const saved = () => useAppStore.getState().settings!.sourceControlAi!
  const settle = async (expected: string[]) => {
    await act(async () => {})
    expect(requests).toEqual(expected)
  }
  const openRoot = () =>
    fireEvent.pointerDown(card.row.getByRole('button', { name: 'Select agent' }), { button: 0 })
  const retireSetup = () =>
    fireEvent.keyDown(screen.getByLabelText('Search models'), { key: 'ArrowLeft' })
  const changeAgent = (agentId: 'claude' | 'codex') =>
    act(() => {
      useAppStore.setState(({ settings }) => ({
        settings: settings && {
          ...settings,
          sourceControlAi: {
            ...settings.sourceControlAi!,
            actions: { ...settings.sourceControlAi?.actions, commitMessage: { agentId } }
          }
        }
      }))
    })
  card.open('Claude')
  await settle(['claude'])
  retireSetup()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  openRoot()
  await settle(['claude', 'claude'])
  fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }))
  await waitFor(() => expect(saved().actions?.commitMessage?.agentId).toBe('codex'))
  openRoot()
  await settle(['claude', 'claude', 'codex'])
  fireEvent.click(screen.getByRole('button', { name: 'Configure Codex' }))
  expect(await screen.findByRole('option', { name: 'codex fresh' })).toBeTruthy()
  await settle(['claude', 'claude', 'codex', 'codex'])
  const configure = screen.getByRole('button', { name: 'Configure Codex' })
  fireEvent.pointerEnter(configure, { pointerType: 'mouse' })
  fireEvent.click(configure)
  await settle(['claude', 'claude', 'codex', 'codex'])

  // A live setup keeps its draft while a newly controlled agent gets its own inventory.
  changeAgent('claude')
  await settle(['claude', 'claude', 'codex', 'codex', 'claude'])
  expect(screen.getByRole('option', { name: 'codex fresh' })).toBeTruthy()
  retireSetup()
  fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
  await settle(['claude', 'claude', 'codex', 'codex', 'claude', 'claude'])
  retireSetup()
  changeAgent('codex')
  await settle(['claude', 'claude', 'codex', 'codex', 'claude', 'claude', 'codex'])
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  changeAgent('claude')
  await settle(['claude', 'claude', 'codex', 'codex', 'claude', 'claude', 'codex'])
  openRoot()
  await settle(['claude', 'claude', 'codex', 'codex', 'claude', 'claude', 'codex', 'claude'])
  expect(saved().discoveredModelsByAgentByHost?.local).toMatchObject({
    claude: [{ id: 'claude-fresh', label: 'claude fresh' }],
    codex: [{ id: 'codex-fresh', label: 'codex fresh' }]
  })
  expect(saved().modelOverridesByOperation?.commitMessage).toBeUndefined()
})
