// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
import { useAppStore } from '@/store'
import { TooltipProvider } from '../../ui/tooltip'
import { AgentLaunchChoiceEditor } from './AgentLaunchChoiceEditor'
import { groupAntigravityModelEfforts } from '../../../../../shared/agent-session/options/antigravity-model-efforts'
import { SourceControlActionModelPicker } from '../../settings/source-control/SourceControlActionModelPicker'

const call = vi.hoisted(() => vi.fn())
const menus = vi.hoisted(() => new Map<string, string[]>())
const select = vi.hoisted(() => new Map<string, (value: string) => void>())
const terminalRead = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/terminal/terminal-model-discovery-client', () => ({
  readAntigravityHostTerminalCatalog: terminalRead
}))

vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: call
}))
vi.mock('./AgentChoiceMenu', () => ({
  AgentChoiceMenu: ({
    label,
    choices,
    onChange
  }: {
    label: string
    choices: readonly { value: string }[]
    onChange: (value: string) => void
  }) => {
    select.set(label, onChange)
    menus.set(
      label,
      choices.map(({ value }) => value)
    )
    return null
  }
}))

// A Codex account answer: its models are scoped, so no new chat in another workspace may reuse it.
const LISTED = {
  origin: 'probe',
  modelsDifferByWorkspace: true,
  models: [
    {
      id: 'gpt-6-astra',
      label: 'GPT-6-Astra',
      isDefault: true,
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'ultra', label: 'Ultra' }
      ]
    },
    { id: 'gpt-reserve', label: 'GPT-Reserve', hidden: true, efforts: [] }
  ]
}

const HOST = { kind: 'environment', environmentId: 'env-1' } as const

function renderEditor(model?: string): void {
  render(
    <TooltipProvider>
      <AgentLaunchChoiceEditor
        agent="codex"
        label="Codex"
        choices={model ? { model } : undefined}
        userArgs=""
        permission={undefined}
        catalogTarget={HOST}
        save={async () => {}}
      />
    </TooltipProvider>
  )
}

describe('AgentLaunchChoiceEditor model list', () => {
  const initialSettings = useAppStore.getState().settings

  beforeEach(() => {
    call.mockReset()
    terminalRead.mockReset()
    menus.clear()
    select.clear()
    resetHostModelCatalogSnapshotsForTests()
  })
  afterEach(() => {
    cleanup()
    useAppStore.setState({ settings: initialSettings })
  })

  it('shows the refreshed model after the agent command changes and ignores the older answer', async () => {
    let answerOlder: (catalog: unknown) => void = () => {}
    call.mockReturnValueOnce(new Promise((resolve) => (answerOlder = resolve)))
    call.mockResolvedValueOnce({
      ...LISTED,
      models: [{ id: 'gpt-wrapped', label: 'GPT Wrapped', efforts: [] }]
    })
    const settings = getDefaultSettings('')
    useAppStore.setState({ settings })
    renderEditor()

    act(() => {
      useAppStore.setState({
        settings: { ...settings, agentCmdOverrides: { codex: 'wrapped-codex' } }
      })
    })

    await waitFor(() => expect(menus.get('Model')).toEqual(['__agent_default__', 'gpt-wrapped']))
    await act(async () => answerOlder(LISTED))
    expect(menus.get('Model')).toEqual(['__agent_default__', 'gpt-wrapped'])
  })

  it('shows CLI-grouped Antigravity models and efforts in agent Settings while preserving a saved variant', async () => {
    terminalRead.mockResolvedValue({
      origin: 'probe',
      models: groupAntigravityModelEfforts([
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
        { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
        { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' }
      ])
    })
    useAppStore.setState({ settings: getDefaultSettings('') })
    const save = vi.fn()
    render(
      <TooltipProvider>
        <AgentLaunchChoiceEditor
          agent="antigravity"
          label="Antigravity"
          choices={{ model: 'gemini-3.8-flash-medium', options: { effort: 'low' } }}
          userArgs=""
          permission={undefined}
          catalogTarget={HOST}
          save={save}
        />
      </TooltipProvider>
    )
    await waitFor(() =>
      expect(menus.get('Model')).toEqual([
        '__agent_default__',
        'gemini-3.8-flash',
        'claude-sonnet-4-6',
        'gemini-3.8-flash-medium'
      ])
    )
    expect(menus.get('Reasoning effort')).toEqual(['__agent_default__', 'low', 'medium', 'high'])
    expect(call).not.toHaveBeenCalled()
    expect(terminalRead).toHaveBeenCalledWith(HOST)
    expect(save).not.toHaveBeenCalled()
    act(() => select.get('Reasoning effort')?.('high'))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        { model: 'gemini-3.8-flash', options: { effort: 'high' } },
        ''
      )
    )
  })

  it('keeps the mixed-route source-control effort control for saved Antigravity actions', () => {
    render(
      <TooltipProvider>
        <SourceControlActionModelPicker
          agent="antigravity"
          value={{ agentId: 'antigravity', model: 'saved-model', options: { effort: 'low' } }}
          onChange={() => {}}
        />
      </TooltipProvider>
    )
    expect(menus.get('Reasoning effort')).toEqual(['__agent_default__', 'low', 'medium', 'high'])
  })
})
