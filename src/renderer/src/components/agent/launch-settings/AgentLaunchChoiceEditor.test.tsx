// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import {
  forgetHostModelCatalogSnapshots,
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
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
    menus.clear()
    resetHostModelCatalogSnapshotsForTests()
  })
  afterEach(() => {
    cleanup()
    useAppStore.setState({ settings: initialSettings })
  })

  it('lists the host models and the picked model efforts, keeping a saved unlisted model', async () => {
    call.mockResolvedValue(LISTED)
    renderEditor('gpt-6-astra')
    await waitFor(() => expect(menus.get('Model')).toEqual(['__agent_default__', 'gpt-6-astra']))
    expect(menus.get('Reasoning effort')).toEqual(['__agent_default__', 'low', 'ultra'])
    expect(call).toHaveBeenCalledWith(HOST, 'agentSession.modelCatalog', { agent: 'codex' })
    expect(document.querySelector('[data-agent-model-list-fallback]')).toBeNull()

    cleanup()
    renderEditor('gpt-old')
    await waitFor(() =>
      expect(menus.get('Model')).toEqual(['__agent_default__', 'gpt-6-astra', 'gpt-old'])
    )
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

  it('shows the new account models when the host drops its lists while the row stays open', async () => {
    call.mockResolvedValueOnce(LISTED)
    renderEditor()
    await waitFor(() => expect(menus.get('Model')).toEqual(['__agent_default__', 'gpt-6-astra']))

    call.mockResolvedValueOnce({
      ...LISTED,
      models: [{ id: 'gpt-other-account', label: 'GPT Other Account', efforts: [] }]
    })
    act(() => forgetHostModelCatalogSnapshots(HOST))

    await waitFor(() =>
      expect(menus.get('Model')).toEqual(['__agent_default__', 'gpt-other-account'])
    )
  })

  it('waits for a listing the host is still running, again when one wait runs out', async () => {
    call.mockResolvedValueOnce({ origin: 'unknown', listingInProgress: true })
    call.mockResolvedValueOnce({ origin: 'unknown', listingInProgress: true, waitExpired: true })
    call.mockResolvedValueOnce(LISTED)
    renderEditor()
    await waitFor(() => expect(menus.get('Model')).toEqual(['__agent_default__', 'gpt-6-astra']))
    expect(call).toHaveBeenLastCalledWith(HOST, 'agentSession.modelCatalog', {
      agent: 'codex',
      waitForListing: true
    })
    expect(call).toHaveBeenCalledTimes(3)
    expect(document.querySelector('[data-agent-model-list-fallback]')).toBeNull()
  })

  it('says the list is built in once the host fails to answer, even with an older answer', async () => {
    recordHostModelCatalogSnapshot(HOST, 'codex', null, {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'gpt-older', label: 'GPT Older', isDefault: false, efforts: [] }]
    })
    call.mockRejectedValue(new Error('offline'))
    renderEditor()
    expect(menus.get('Model')).toContain('gpt-older')
    expect(document.querySelector('[data-agent-model-list-fallback]')).toBeNull()
    await waitFor(() =>
      expect(document.querySelector('[data-agent-model-list-fallback]')).not.toBeNull()
    )
    expect(menus.get('Model')).toContain('gpt-5.6-sol')
    expect(menus.get('Model')).not.toContain('gpt-older')
  })
})
