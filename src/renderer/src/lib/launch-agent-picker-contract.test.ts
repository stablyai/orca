// @vitest-environment happy-dom
import type * as SettingsTransport from '../components/settings/agent-launch-settings-transport'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { AgentLaunchSetupPanel } from '../components/agent/AgentLaunchSetupPanel'
import { TooltipProvider } from '../components/ui/tooltip'
import { useAgentLaunchPickerInventory } from '../components/agent/use-agent-launch-picker-inventory'
import type { NewTabAgentMenuModel } from '../components/tab-bar/new-tab-agent-menu-model'
import type { AgentPickerDraft, AgentPickerEntry } from '../../../shared/agent-launch-picker'
import {
  agentPickerDraft,
  agentPickerLaunchInputs,
  agentPickerEntriesFromRows
} from '../../../shared/agent-launch-picker'
import { editAgentPickerPermission } from '../../../shared/agent-launch-picker-permission'
import {
  editAgentPickerPanelArguments,
  editAgentPickerPanelText,
  editAgentPickerSpeed,
  agentPickerPanelArguments
} from '../../../shared/agent-launch-picker-arguments'
import {
  mockCreateTab,
  queuedStartups,
  store,
  mockToastError,
  mockCreateWebRuntimeSessionTerminal,
  mockIsWebRuntimeSessionActive
} from './launch-agent-in-new-tab-test-fixture'

import { buildNewTabAgentMenuRows } from '../../../shared/agent-launch-picker-rows'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { fetchCodexModelCatalogListing } from './codex-model-catalog-reader-test-fixture'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const inventory = vi.hoisted(() => ({ settings: vi.fn(), legacy: vi.fn(), session: vi.fn() }))
vi.mock('../components/settings/agent-launch-settings-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof SettingsTransport>()),
  readHostAgentLaunchSettings: inventory.settings
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: inventory.legacy }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: inventory.session
}))

describe('picker window launch contract', () => {
  it.each(['claude', 'codex'] as const)(
    'preserves %s permission and model intent through the actual picker-to-terminal compiler',
    async (agent) => {
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      const {
        agentPickerChoiceSeeds,
        agentPickerDraft,
        editAgentPickerArguments,
        agentPickerLaunchInputs
      } = await import('../../../shared/agent-launch-picker')
      const settings = {
        agentPermissionDefault: 'ask' as const,
        agentDefaultArgs: { [agent]: '--add-dir docs' },
        nativeChatSessionOptions: { [agent]: { model: 'remembered-chat-model' } }
      }
      Object.assign(store.settings, settings)
      const entry = {
        agent,
        label: agent,
        rows: [{ agent, kind: 'terminal' as const }],
        surfaces: ['terminal' as const, 'chat' as const],
        defaultSurface: 'terminal' as const,
        catalog: { origin: 'unknown' as const },
        ...agentPickerChoiceSeeds(agent, settings)
      }
      const launch = (input = {}) => {
        mockCreateTab.mockClear()
        launchAgentInNewTab({
          requestId: 'picker-contract',
          agent,
          worktreeId: 'wt-1',
          requestedSurface: 'terminal',
          ...input
        })
        return queuedStartups()[0]?.command
      }
      const ordinary = launch()
      expect(launch(agentPickerLaunchInputs(agentPickerDraft(entry), entry))).toBe(ordinary)
      for (const text of ['--add-dir src', '', '--unknown opaque --add-dir src']) {
        const command = launch(
          agentPickerLaunchInputs(editAgentPickerArguments(agentPickerDraft(entry), text), entry)
        )
        expect(command).toContain(
          agent === 'claude'
            ? "'--permission-mode' 'default'"
            : "'-a' 'on-request' '-s' 'read-only'"
        )
        expect(command).not.toContain('remembered-chat-model')
        expect(command).not.toContain('docs')
      }
      const raw =
        agent === 'claude'
          ? '--permission-mode plan --add-dir src'
          : '-a never -s danger-full-access --add-dir src'
      const command = launch(
        agentPickerLaunchInputs(editAgentPickerArguments(agentPickerDraft(entry), raw), entry)
      )
      expect(command).toContain(agent === 'claude' ? "'--permission-mode' 'plan'" : "'-a' 'never'")
      expect(command).not.toContain(
        agent === 'claude' ? "'--permission-mode' 'default'" : "'-a' 'on-request'"
      )
    }
  )

  it.each(['local', 'ssh', 'paired', 'older-host'] as const)(
    'keeps ordinary and configured-default launch input/failure contracts on %s',
    async (target) => {
      const launcher = await import('./launch-agent-in-new-tab')
      const dispatch = vi.spyOn(launcher, 'launchAgentInNewTab')
      const { launchAgentInNewTab } = launcher
      const { AgentLaunchPickerMenu } = await import('../components/agent/AgentLaunchPickerMenu')
      const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } =
        await import('../components/ui/dropdown-menu')
      const { useTabAgentMenuLaunch } = await import('../components/tab-bar/QuickLaunchButton')
      const { EntryActionRow } = await import('../components/tab-bar/TabBarCreateEntryRow')
      const { matchingAgentPickerLaunchOptions, configuredAgentPickerLaunchOption } =
        await import('../components/tab-bar/tab-agent-launch-options')
      const { agentPickerChoiceSeeds, agentPickerLaunchInputs } =
        await import('../../../shared/agent-launch-picker')
      Object.assign(store.settings, { agentDefaultArgs: { claude: '--add-dir docs' } })
      if (target === 'ssh') {
        store.repos[0].connectionId = 'ssh-target-1'
      }
      if (target === 'paired' || target === 'older-host') {
        mockIsWebRuntimeSessionActive.mockReturnValue(true)
        store.settings.activeRuntimeEnvironmentId = 'web-runtime'
        Object.assign(store.repos[0], { executionHostId: 'runtime:web-runtime' })
        if (target === 'older-host') {
          mockCreateWebRuntimeSessionTerminal.mockResolvedValue({
            status: 'failed',
            message: 'Upgrade the remote Orca host before starting or resuming agent sessions.'
          })
        }
      }
      const host: ExecutionHostId =
        target === 'ssh' ? 'ssh:ssh-target-1' : target === 'local' ? 'local' : 'runtime:web-runtime'
      const rows = buildNewTabAgentMenuRows({
        settings: { experimentalNativeChat: true, nativeChatProviders: { claude: false } },
        detectedOnHost: ['claude'],
        chatAgents: ['claude'],
        hostChatAnswer: () => (target === 'ssh' ? 'ssh' : 'yes'),
        chatProgram: () => 'available'
      }).map((row) => ({ ...row, executionHostId: host }))
      const entry = agentPickerEntriesFromRows(
        rows,
        ['claude'],
        (selected) => agentPickerChoiceSeeds(selected, store.settings),
        () => 'Claude'
      )[0]
      entry.catalog = {
        origin: 'probe',
        fetchedAt: 1,
        models: [
          {
            id: 'opus',
            label: 'Opus',
            isDefault: true,
            efforts: [{ value: 'high', label: 'High' }]
          }
        ]
      }
      expect(entry.defaultSurface).toBe('terminal')
      expect(entry.surfaces).toEqual(target === 'ssh' ? ['terminal'] : ['chat', 'terminal'])
      const option = matchingAgentPickerLaunchOptions([entry], 'opus high')[0]
      function Menu({ omnibox }: { omnibox: boolean }) {
        const runLaunch = useTabAgentMenuLaunch({
          worktreeId: 'wt-1',
          groupId: 'group-1',
          onFocusTerminal: () => {}
        })
        return createElement(
          TooltipProvider,
          null,
          omnibox
            ? createElement(EntryActionRow, {
                id: 'setup-result',
                selected: true,
                option: { kind: 'agent', option },
                onClick: () => runLaunch(option.row!, option.setup, entry),
                onUseAgent: (draft) => {
                  const configured = configuredAgentPickerLaunchOption(option, draft)
                  runLaunch(configured.row!, configured.setup, entry)
                }
              })
            : createElement(
                DropdownMenu,
                { defaultOpen: true, modal: false },
                createElement(DropdownMenuTrigger, null, 'New tab'),
                createElement(
                  DropdownMenuContent,
                  null,
                  createElement(AgentLaunchPickerMenu, {
                    entries: [entry],
                    runLaunch,
                    model: {
                      state: 'settled',
                      rows,
                      detection: {
                        detectedIds: ['claude'],
                        isLoading: false,
                        isRefreshing: false,
                        detectionFailed: false,
                        needsServerUpdate: false,
                        refresh: async (): Promise<AgentPickerEntry['agent'][]> => ['claude']
                      }
                    }
                  })
                )
              )
        )
      }
      const perform = async (inputs = {}, menu?: 'ordinary' | 'searched' | 'omnibox') => {
        mockCreateTab.mockClear()
        mockCreateWebRuntimeSessionTerminal.mockClear()
        mockToastError.mockClear()
        dispatch.mockClear()
        if (menu) {
          render(createElement(Menu, { omnibox: menu === 'omnibox' }))
          if (menu === 'searched') {
            fireEvent.change(document.querySelector('input')!, { target: { value: 'opus high' } })
          }
          fireEvent.click(document.querySelector('button[aria-label="Configure Claude"]')!)
          expect(dispatch).not.toHaveBeenCalled()
          fireEvent.click(
            [...document.querySelectorAll('button')].find(
              (button) => button.textContent === 'Launch terminal'
            )!
          )
          expect(dispatch).toHaveBeenCalledOnce()
          expect(dispatch.mock.calls[0][0]).toMatchObject({
            requestedSurface: 'terminal',
            selectedExecutionHostId: host
          })
        } else {
          launchAgentInNewTab({
            requestId: 'equivalence',
            agent: 'claude',
            worktreeId: 'wt-1',
            groupId: 'group-1',
            requestedSurface: 'terminal',
            selectedExecutionHostId: host,
            ...inputs
          })
        }
        const call = dispatch.mock.results.at(-1)
        const result = call?.type === 'return' ? call.value : undefined
        await result?.terminalCompletion
        cleanup()
        return {
          command: queuedStartups()[0]?.command,
          remote: mockCreateWebRuntimeSessionTerminal.mock.calls[0]?.[0],
          errors: mockToastError.mock.calls,
          surface: result?.surface
        }
      }
      const ordinary = await perform()
      const configured = await perform({}, 'ordinary')
      expect(configured).toEqual(ordinary)
      expect(ordinary.surface?.kind).toBe(
        target === 'paired' || target === 'older-host' ? 'host-published' : 'local-terminal'
      )
      if (target === 'older-host') {
        expect(configured.errors).toHaveLength(1)
      }
      const expectedSearch = await perform(
        agentPickerLaunchInputs({ ...option.setup!, surface: 'terminal' }, entry)
      )
      expect(await perform({}, 'searched')).toEqual(expectedSearch)
      expect(await perform({}, 'omnibox')).toEqual(expectedSearch)
      expect(expectedSearch.command ?? expectedSearch.remote?.command ?? '').toContain('opus')
      dispatch.mockRestore()
    }
  )
})

it.each(['claude', 'codex'] as const)(
  'passes %s speed through the real picker-to-terminal compiler',
  async (agent) => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const { agentPickerDraft, agentPickerLaunchInputs } =
      await import('../../../shared/agent-launch-picker')
    const { editAgentPickerSpeed } = await import('../../../shared/agent-launch-picker-arguments')
    const options: Record<string, string> =
      agent === 'claude' ? { fastMode: 'false' } : { serviceTier: 'default' }
    const entry = {
      agent,
      label: agent,
      rows: [{ agent, kind: 'terminal' as const }],
      surfaces: ['chat' as const, 'terminal' as const],
      defaultSurface: 'chat' as const,
      terminal: { permissionMode: 'ask' as const },
      structured: {
        model: agent === 'claude' ? 'opus' : 'account-model',
        permissionMode: 'ask' as const,
        options
      },
      arguments:
        agent === 'claude'
          ? '--settings ./team.json --settings \'{"language":"french"}\''
          : '--add-dir docs',
      catalog: {
        origin: 'probe' as const,
        fetchedAt: 1,
        models: [
          {
            id: agent === 'claude' ? 'opus' : 'account-model',
            label: 'Model',
            isDefault: true,
            efforts: [],
            supportsFastMode: true,
            ...(agent === 'codex'
              ? { serviceTiers: [{ value: 'account_fast_v9', label: 'Fast' }] }
              : {})
          }
        ]
      }
    }
    Object.assign(store.settings, { agentPermissionDefault: 'ask' })
    const draft = editAgentPickerSpeed(
      entry,
      agentPickerDraft(entry),
      agent === 'claude' ? 'fastMode' : 'serviceTier',
      agent === 'claude' ? 'true' : 'account_fast_v9',
      entry.structured.model
    )
    const launch = {
      ...draft,
      surface: 'terminal' as const
    }
    mockCreateTab.mockClear()
    launchAgentInNewTab({
      requestId: 'picker-fast-contract',
      agent,
      worktreeId: 'wt-1',
      requestedSurface: 'terminal',
      ...agentPickerLaunchInputs(launch, entry)
    })
    const command = queuedStartups()[0]?.command ?? ''
    expect(command).toContain(
      agent === 'claude' ? '"fastMode":true' : 'service_tier=account_fast_v9'
    )
    if (agent === 'claude') {
      expect(command).toContain('"language":"french"')
      expect(command).toContain('./team.json')
    }
    expect(command).not.toContain('account-model')
  }
)

it.each(['claude', 'codex'] as const)(
  'keeps failed %s defaults unknown through acquisition, controls, projection and actual dispatch, then wakes to a permission-preserving edit',
  async (agent) => {
    const { projectAgentLaunchSettings } = await import('../../../shared/agent-launch-settings')
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const settings = {
      agentPermissionDefault: 'ask' as const,
      agentDefaultArgs: { [agent]: '--add-dir docs' }
    }
    Object.assign(store.settings, settings)
    inventory.settings.mockRejectedValue(new Error('offline'))
    inventory.legacy.mockRejectedValue(new Error('offline'))
    inventory.session.mockImplementation(async (_target, method) =>
      method === 'agentSession.modelCatalog'
        ? { origin: 'unknown' }
        : { seedOptions: { permissionMode: 'ask' } }
    )
    const menu: NewTabAgentMenuModel = {
      state: 'settled',
      rows: [{ agent, kind: 'chat', executionHostId: 'runtime:authority' }],
      detection: {
        detectedIds: [agent],
        isLoading: false,
        isRefreshing: false,
        detectionFailed: false,
        needsServerUpdate: false,
        refresh: async () => [agent]
      },
      pickerContext: {
        workspace: { kind: 'git-worktree', worktreeId: 'wt-1' },
        executionHostId: 'runtime:authority',
        pairingRevision: 1,
        runtimeId: agent,
        settings: null,
        key: `contract-${agent}`
      }
    }
    let current: AgentPickerEntry
    const launches: AgentPickerDraft[] = []
    function Panel({ open }: { open: boolean }) {
      const entries = useAgentLaunchPickerInventory('wt-1', menu, open)
      current = entries[0]
      return open
        ? createElement(
            TooltipProvider,
            null,
            createElement(AgentLaunchSetupPanel, {
              key: current.ownerKey,
              entry: current,
              onUse: (draft) => launches.push(draft)
            })
          )
        : null
    }
    const view = render(createElement(Panel, { open: true }))
    try {
      await act(async () => {})
      const entry = current!
      expect(entry.defaultsPending).toBe(true)
      fireEvent.click(view.getByLabelText('Toggle Arguments'))
      expect(view.getByLabelText('Arguments')).toHaveProperty('disabled', true)
      expect(view.container.querySelector('button[aria-label$=" permissions"]')).toHaveProperty(
        'disabled',
        true
      )
      const draft = agentPickerDraft(entry)
      for (const next of [
        draft,
        { ...draft, arguments: '--add-dir src' },
        editAgentPickerPanelArguments(entry, draft, '--add-dir src'),
        editAgentPickerPanelText(entry, draft, '--add-dir src'),
        editAgentPickerPermission(entry, draft, 'full-access'),
        editAgentPickerSpeed(
          entry,
          draft,
          agent === 'claude' ? 'fastMode' : 'serviceTier',
          agent === 'claude' ? 'true' : 'priority'
        )
      ]) {
        for (const surface of ['chat', 'terminal'] as const) {
          expect(agentPickerLaunchInputs({ ...next, surface }, entry)).not.toHaveProperty(
            'agentArgs'
          )
        }
      }
      for (const button of ['Launch chat', 'Launch terminal']) {
        fireEvent.click(view.getByText(button))
      }
      fireEvent.keyDown(view.getByLabelText('Arguments'), { key: 'Enter' })
      expect(launches).toHaveLength(3)
      for (const next of launches) {
        expect(agentPickerLaunchInputs(next, entry)).toEqual({})
      }
      mockCreateTab.mockClear()
      launchAgentInNewTab({
        requestId: 'unknown-defaults',
        agent,
        worktreeId: 'wt-1',
        requestedSurface: 'terminal',
        ...agentPickerLaunchInputs({ ...launches[1], surface: 'terminal' }, entry)
      })
      expect(queuedStartups()[0]?.command).toContain('docs')
      expect(queuedStartups()[0]?.command).toContain(
        agent === 'claude' ? "'--permission-mode' 'default'" : "'-a' 'on-request' '-s' 'read-only'"
      )
      view.rerender(createElement(Panel, { open: false }))
      const read = Promise.withResolvers<ReturnType<typeof projectAgentLaunchSettings>>()
      inventory.settings.mockReturnValue(read.promise)
      view.rerender(createElement(Panel, { open: true }))
      expect(current!.defaultsPending).toBe(true)
      await act(async () => read.resolve(projectAgentLaunchSettings(settings)))
      fireEvent.click(view.getByLabelText('Toggle Arguments'))
      const input = view.getByLabelText('Arguments')
      expect(input).toHaveProperty('disabled', false)
      for (const text of ['--add-dir src', '']) {
        fireEvent.change(input, { target: { value: text } })
        fireEvent.click(view.getByText('Launch terminal'))
        const launch = agentPickerLaunchInputs(launches.at(-1)!, current!)
        expect(launch.agentArgs).toContain(
          agent === 'claude' ? '--permission-mode default' : '-a on-request -s read-only'
        )
        mockCreateTab.mockClear()
        launchAgentInNewTab({
          requestId: 'known-edit',
          agent,
          worktreeId: 'wt-1',
          requestedSurface: 'terminal',
          ...launch
        })
        const command = queuedStartups()[0]?.command
        expect(command).toContain(
          agent === 'claude'
            ? "'--permission-mode' 'default'"
            : "'-a' 'on-request' '-s' 'read-only'"
        )
        expect(command).not.toContain('docs')
      }
      const knownDraft = agentPickerDraft(current!)
      const badge = agentPickerPanelArguments(current!, knownDraft).chips.find(
        (c) => c.key === 'permissionMode'
      )!
      const removed = badge.remove()
      expect(
        agentPickerLaunchInputs({ ...removed, surface: 'terminal' }, current!).agentArgs
      ).not.toContain(agent === 'claude' ? '--permission-mode' : '-a on-request')
    } finally {
      cleanup()
    }
  }
)

it('passes the recorded Codex catalog tier and approval/sandbox policy through the common reader, picker and real compiler', async () => {
  const { default: capture } =
    await import('../../../shared/fixtures/agent-picker-cli-recordings.json')
  const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
  const listing = await fetchCodexModelCatalogListing({
    connection: { request: vi.fn().mockResolvedValue(capture.modelList) }
  })
  const model = listing.models[0]
  const tier = model.serviceTiers![0].value
  expect(capture.policy.sandbox.type).toBe('workspaceWrite')
  const raw = `-a ${capture.policy.approvalPolicy} -s workspace-write -c approvals_reviewer=${capture.policy.approvalsReviewer}`
  const entry: AgentPickerEntry = {
    agent: 'codex',
    label: 'Codex',
    rows: [{ agent: 'codex', kind: 'chat' }],
    surfaces: ['chat', 'terminal'],
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    arguments: `${raw} --add-dir docs`,
    catalog: { origin: 'probe', fetchedAt: 1, models: listing.models }
  }
  const selected = editAgentPickerSpeed(
    entry,
    agentPickerDraft(entry),
    'serviceTier',
    tier,
    model.id
  )
  const view = agentPickerPanelArguments(entry, selected, model.id)
  expect(view.chips.map((chip) => chip.key)).toContain('permissionMode')
  const edited = editAgentPickerPanelText(entry, selected, '--add-dir src', model.id)
  for (const next of [selected, edited]) {
    mockCreateTab.mockClear()
    const inputs = agentPickerLaunchInputs({ ...next, surface: 'terminal' }, entry)
    launchAgentInNewTab({
      requestId: 'recorded-policy',
      agent: 'codex',
      worktreeId: 'wt-1',
      requestedSurface: 'terminal',
      ...inputs
    })
    expect(queuedStartups()[0]?.command).toContain(`'service_tier=${tier}'`)
    expect(queuedStartups()[0]?.command).toContain("'-a' 'on-request' '-s' 'workspace-write'")
    expect(
      agentPickerLaunchInputs({ ...next, surface: 'chat' }, entry).sessionOptions?.serviceTier
    ).toBe(tier)
  }
  const standard = editAgentPickerPanelText(
    entry,
    selected,
    '-c service_tier=default --add-dir src',
    model.id
  )
  expect(
    agentPickerLaunchInputs({ ...standard, surface: 'chat' }, entry).sessionOptions?.serviceTier
  ).toBe('default')
  expect(agentPickerLaunchInputs({ ...standard, surface: 'terminal' }, entry).agentArgs).toContain(
    'service_tier=default'
  )
  expect(view.chips.some((chip) => chip.key === 'serviceTier')).toBe(true)
  const removed = view.chips.find((chip) => chip.key === 'serviceTier')!.remove()
  expect(
    agentPickerPanelArguments(entry, removed, model.id).chips.some(
      (chip) => chip.key === 'serviceTier'
    )
  ).toBe(false)
})
