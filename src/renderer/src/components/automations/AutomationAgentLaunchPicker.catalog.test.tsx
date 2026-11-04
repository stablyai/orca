// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type * as LaunchSetup from '../agent/AgentLaunchSetupButton'
import { AgentLaunchSetupButton } from '../agent/AgentLaunchSetupButton'
import * as inventoryModule from '../agent/use-agent-launch-picker-inventory'
import {
  createAgentPickerInventorySource,
  useAgentPickerInventoryEntries
} from '../agent/agent-launch-picker-acquisition'
import { DropdownMenuSub, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { applyAgentPickerEdit } from '../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import type * as PickerEdits from '../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { AutomationAgentLaunchPicker } from './AutomationAgentLaunchPicker'
import { buildAutomationEditDraft } from './automation-edit-draft'
import { makeAutomation } from './automations-page-fixtures'
import type { AutomationDraft } from './AutomationEditorDialog'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
vi.mock('../tab-bar/use-new-tab-agent-menu-rows', () => {
  const detection = {
    detectedIds: ['codex', 'claude'],
    isLoading: false,
    isRefreshing: false,
    detectionFailed: false,
    needsServerUpdate: false,
    refresh: async () => ['codex', 'claude']
  }
  const observation = {
    model: { state: 'settled', rows: [], detection },
    detection,
    contextKey: 'automation-catalog-test'
  }
  return { useAgentMenuObservation: () => observation }
})
vi.mock('../agent/AgentLaunchSetupButton', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchSetup>()),
  AgentLaunchSetupButton: vi.fn((props: ComponentProps<typeof AgentLaunchSetupButton>) => (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger asChild hideChevron>
        {props.renderAnchor?.(<button>Setup</button>)}
      </DropdownMenuSubTrigger>
    </DropdownMenuSub>
  ))
}))
vi.mock(
  '../../../../shared/agent-launch/picker/agent-launch-picker-edits',
  async (importOriginal) => {
    const actual = await importOriginal<typeof PickerEdits>()
    return { ...actual, applyAgentPickerEdit: vi.fn(actual.applyAgentPickerEdit) }
  }
)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it.each([1, 10])(
  'isolates %i unrelated Automation catalog publications and accepts the latest Codex model and source',
  async (publications) => {
    const codex: AgentPickerEntry = {
      agent: 'codex',
      label: 'Codex',
      ownerKey: 'automation-catalog-codex',
      rows: [{ agent: 'codex', kind: 'cli' }],
      surfaces: ['terminal'],
      defaultSurface: 'terminal',
      terminal: {},
      structured: {},
      catalog: {
        origin: 'probe',
        fetchedAt: 1,
        models: [
          {
            id: 'host-model',
            label: 'Host model',
            isDefault: true,
            efforts: [{ value: 'low', label: 'Low' }]
          }
        ]
      }
    }
    const claude: AgentPickerEntry = {
      ...codex,
      agent: 'claude',
      label: 'Claude',
      ownerKey: 'automation-catalog-claude',
      rows: [{ agent: 'claude', kind: 'cli' }],
      catalog: { origin: 'probe', fetchedAt: 1, models: [] }
    }
    const inventory = createAgentPickerInventorySource([codex, claude])
    vi.spyOn(inventoryModule, 'useAgentLaunchPickerInventory').mockImplementation(() =>
      useAgentPickerInventoryEntries(inventory)
    )
    const workspace = { kind: 'floating' as const }
    const authority = { kind: 'desktop' as const }
    const visibleAgents = getAgentCatalog().filter(({ id }) => id === 'codex' || id === 'claude')
    let draft = buildAutomationEditDraft(
      makeAutomation({
        agentId: 'codex',
        launchSetup: { surface: 'terminal', agentArgs: '--add-dir original' }
      })
    )
    const onDraftChange = vi.fn((update: (current: AutomationDraft) => AutomationDraft) => {
      draft = update(draft)
    })
    const picker = () => (
      <AutomationAgentLaunchPicker
        draft={draft}
        workspace={workspace}
        authority={authority}
        visibleAgents={visibleAgents}
        settings={null}
        surface="terminal"
        chatSupported={false}
        onDraftChange={onDraftChange}
      />
    )
    const view = render(picker())
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'host low' } })
    expect(screen.getByRole('menuitem', { name: /Codex · Host model · Low/ })).toBeTruthy()
    await act(async () => {})
    vi.mocked(AgentLaunchSetupButton).mockClear()
    vi.mocked(applyAgentPickerEdit).mockClear()

    let nextClaude = claude
    for (let publication = 0; publication < publications; publication++) {
      nextClaude = {
        ...nextClaude,
        catalog: { origin: 'probe', fetchedAt: publication + 2, models: [] }
      }
      await act(async () => inventory.publish([codex, nextClaude]))
    }
    expect(
      vi
        .mocked(AgentLaunchSetupButton)
        .mock.calls.filter(([props]) => props.entry.agent === 'codex')
    ).toHaveLength(0)
    expect(applyAgentPickerEdit).not.toHaveBeenCalled()
    expect(onDraftChange).not.toHaveBeenCalled()

    const nextCodex: AgentPickerEntry = {
      ...codex,
      catalog: {
        origin: 'probe',
        fetchedAt: 2,
        models: [
          {
            id: 'host-model-v2',
            label: 'Host model updated',
            isDefault: true,
            efforts: [{ value: 'low', label: 'Low' }]
          }
        ]
      }
    }
    await act(async () => inventory.publish([nextCodex, nextClaude]))
    expect(screen.queryByRole('menuitem', { name: /Codex · Host model · Low/ })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /Codex · Host model updated · Low/ })).toBeTruthy()
    expect(AgentLaunchSetupButton).toHaveBeenCalled()
    expect(applyAgentPickerEdit).toHaveBeenCalled()

    draft = { ...draft, agentArgs: '--add-dir latest' }
    view.rerender(picker())
    const latest = vi.mocked(AgentLaunchSetupButton).mock.lastCall?.[0]
    expect(latest?.initial?.arguments).toBe('--add-dir latest')
    expect(latest?.seed).toEqual(
      expect.objectContaining({
        arguments: '--add-dir latest',
        choices: { model: 'host-model-v2', options: { effort: 'low' } },
        acceptedEdits: { choices: { model: 'host-model-v2', options: { effort: 'low' } } }
      })
    )
    expect(onDraftChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: /Codex · Host model updated · Low/ }))
    expect(onDraftChange).toHaveBeenCalledTimes(1)
    expect(draft.agentArgs).toBe('--add-dir latest')
    expect(draft.launchPreferences).toEqual({
      model: 'host-model-v2',
      options: { effort: 'low' }
    })
  }
)
