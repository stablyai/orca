// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import { TooltipProvider } from '../../ui/tooltip'
import { AgentLaunchChoiceEditor } from './AgentLaunchChoiceEditor'

const call = vi.hoisted(() => vi.fn())
const menus = vi.hoisted(() => new Map<string, string[]>())

vi.mock('@/runtime/structured-agent-session-client', () => ({
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

const LISTED = {
  origin: 'probe',
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

function renderEditor(model?: string): void {
  render(
    <TooltipProvider>
      <AgentLaunchChoiceEditor
        agent="codex"
        label="Codex"
        choices={model ? { model } : undefined}
        userArgs=""
        permission={undefined}
        catalogTarget={{ kind: 'local' }}
        save={async () => {}}
      />
    </TooltipProvider>
  )
}

describe('AgentLaunchChoiceEditor model list', () => {
  beforeEach(() => {
    call.mockReset()
    menus.clear()
    resetHostModelCatalogSnapshotsForTests()
  })
  afterEach(cleanup)

  it('lists the host models and the picked model efforts, keeping a saved unlisted model', async () => {
    call.mockResolvedValue(LISTED)
    renderEditor('gpt-6-astra')
    await waitFor(() => expect(menus.get('Model')).toEqual(['__agent_default__', 'gpt-6-astra']))
    expect(menus.get('Reasoning effort')).toEqual(['__agent_default__', 'low', 'ultra'])

    cleanup()
    renderEditor('gpt-old')
    await waitFor(() =>
      expect(menus.get('Model')).toEqual(['__agent_default__', 'gpt-6-astra', 'gpt-old'])
    )
  })
})
