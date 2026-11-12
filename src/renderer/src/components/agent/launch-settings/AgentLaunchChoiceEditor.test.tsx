// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
import { useAppStore } from '@/store'
import { TooltipProvider } from '../../ui/tooltip'
import { AgentLaunchChoiceEditor } from './AgentLaunchChoiceEditor'

const call = vi.hoisted(() => vi.fn())
const menus = vi.hoisted(() => new Map<string, string[]>())

vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: call
}))
vi.mock('./AgentChoiceMenu', () => ({
  AgentChoiceMenu: ({
    label,
    choices
  }: {
    label: string
    choices: readonly { value: string }[]
  }) => {
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

function renderEditor(): void {
  render(
    <TooltipProvider>
      <AgentLaunchChoiceEditor
        agent="codex"
        label="codex"
        choices={undefined}
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
    menus.clear()
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
})
