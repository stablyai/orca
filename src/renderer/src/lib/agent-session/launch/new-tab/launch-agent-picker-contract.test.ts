import {
  useAgentPickerSetup,
  useAgentPickerDraftScope
} from '../../../../components/agent/agent-launch-picker-drafts'
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { AgentLaunchSetupPanel } from '../../../../components/agent/AgentLaunchSetupPanel'
import { TooltipProvider } from '../../../../components/ui/tooltip'
import { useAgentLaunchPickerInventorySource } from '../../../../components/agent/use-agent-launch-picker-inventory'
import { useAgentPickerInventoryEntries } from '../../../../components/agent/agent-launch-picker-acquisition'
import type { NewTabAgentMenuModel } from '../../../../components/tab-bar/new-tab-agent-menu-model'
import {
  type AgentPickerDraft,
  type AgentPickerEntry,
  agentPickerDraft,
  agentPickerLaunchInputs,
  agentPickerFreshLaunchInputs,
  agentPickerEntriesFromRows
} from '../../../../../../shared/agent-launch/picker/agent-launch-picker'

import {
  acceptAgentPickerArguments,
  applyAgentPickerEdit
} from '../../../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import {
  mockCreateTab,
  queuedStartups,
  store,
  mockToastError,
  mockCreateWebRuntimeSessionTerminal,
  mockIsWebRuntimeSessionActive,
  mockRuntimeEnvironmentSupportsCapabilities
} from './launch-agent-in-new-tab-test-fixture'

import { buildNewTabAgentMenuRows } from '../../../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const inventory = vi.hoisted(() => ({ settings: vi.fn(), legacy: vi.fn(), session: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (...args: unknown[]) =>
    args[1] === 'settings.getAgentLaunch'
      ? { settings: await inventory.settings(...args) }
      : inventory.legacy(...args)
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async () => true,
  runtimeEnvironmentSupportsCapabilities: async () => [false, false]
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: inventory.session
}))

it('preserves authored and explicitly empty Arguments for fresh terminal and chat launches', () => {
  const entry: AgentPickerEntry = {
    agent: 'codex',
    label: 'Codex',
    rows: [],
    surfaces: ['terminal', 'chat'],
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    arguments: '',
    catalog: { origin: 'unknown' }
  }
  for (const { text, expected } of [
    { text: '--add-dir docs', expected: '--add-dir docs' },
    { text: '', expected: null }
  ]) {
    const draft = acceptAgentPickerArguments(
      entry,
      applyAgentPickerEdit(entry, agentPickerDraft(entry), {
        kind: 'arguments',
        text
      })
    )
    for (const surface of ['terminal', 'chat'] as const) {
      const launch = agentPickerFreshLaunchInputs(
        { ...draft, surface },
        {
          surface,
          executionHostId: 'runtime:paired'
        },
        entry
      )
      expect(launch.agentArgs).toBe(expected)
    }
  }
})

describe('picker window launch contract', () => {
  it.each(['claude', 'codex'] as const)(
    'preserves %s permission and model intent through the actual picker-to-terminal compiler',
    async (agent) => {
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      const { agentPickerDraft, agentPickerLaunchInputs } =
        await import('../../../../../../shared/agent-launch/picker/agent-launch-picker')
      const { agentPickerChoiceSeeds } =
        await import('../../../../../../shared/agent-launch/picker/agent-launch-picker-defaults')
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
          agentPickerLaunchInputs(
            acceptAgentPickerArguments(
              entry,
              applyAgentPickerEdit(entry, agentPickerDraft(entry), { kind: 'arguments', text })
            ),
            entry
          )
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
        agentPickerLaunchInputs(
          acceptAgentPickerArguments(
            entry,
            applyAgentPickerEdit(entry, agentPickerDraft(entry), { kind: 'arguments', text: raw })
          ),
          entry
        )
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
      inventory.settings.mockResolvedValue(null)
      mockRuntimeEnvironmentSupportsCapabilities.mockResolvedValue([
        target === 'paired',
        target === 'paired'
      ])
      const launcher = await import('./launch-agent-in-new-tab')
      const dispatch = vi.spyOn(launcher, 'launchAgentInNewTab')
      const { launchAgentInNewTab } = launcher
      const { AgentLaunchPickerMenu } =
        await import('../../../../components/agent/AgentLaunchPickerMenu')
      const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } =
        await import('../../../../components/ui/dropdown-menu')
      const { useTabAgentMenuLaunch } =
        await import('../../../../components/tab-bar/QuickLaunchButton')
      const { EntryActionRow } = await import('../../../../components/tab-bar/TabBarCreateEntryRow')
      const { matchingAgentPickerLaunchOptions, configuredAgentPickerLaunchOption } =
        await import('../../../../components/tab-bar/tab-agent-launch-options')
      const { agentPickerLaunchInputs } =
        await import('../../../../../../shared/agent-launch/picker/agent-launch-picker')
      const { agentPickerChoiceSeeds } =
        await import('../../../../../../shared/agent-launch/picker/agent-launch-picker-defaults')
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
        settings: { agentDefaultSurface: 'chat', nativeChatProviders: { claude: false } },
        detectedOnHost: ['claude'],
        chatAgents: ['claude'],
        hostChatAnswer: () => (target === 'ssh' ? 'ssh' : 'yes'),
        chatProgram: () => 'available'
      }).map((row) => ({ ...row, executionHostId: host }))
      const entry = agentPickerEntriesFromRows(
        rows,
        ['claude'],
        (selected) => agentPickerChoiceSeeds(selected, store.settings),
        () => 'Claude',
        undefined
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
                    runLaunch
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
      const searched = await perform({}, 'searched')
      const omnibox = await perform({}, 'omnibox')
      expect(searched).toEqual(expectedSearch)
      expect(omnibox).toEqual(expectedSearch)
      if (target === 'paired') {
        expect(expectedSearch.remote).toMatchObject({ sessionOptions: { model: 'opus' } })
      } else {
        expect(expectedSearch.command ?? expectedSearch.remote?.command ?? '').toContain('opus')
      }
      const explicit = {
        ...option.setup!,
        surface: 'terminal' as const,
        arguments: '--add-dir src'
      }
      let accepted = acceptAgentPickerArguments(
        entry,
        applyAgentPickerEdit(entry, agentPickerDraft(entry), {
          kind: 'arguments',
          text: '--add-dir src'
        })
      )
      accepted = applyAgentPickerEdit(entry, accepted, {
        kind: 'choice',
        patch: option.setup!.choices
      })
      expect(await perform(agentPickerLaunchInputs(accepted, entry))).toEqual(
        await perform(agentPickerLaunchInputs(explicit, entry))
      )
      dispatch.mockRestore()
    }
  )
})

it('keeps pristine, edited and reopened historical-host picker launches free of desktop defaults', async () => {
  const operation =
    await import('@/runtime/hosted-terminals/creation/web-runtime-terminal-create-operation')
  vi.spyOn(operation, 'createWebRuntimeSessionTerminalResult').mockImplementation(
    async ({ legacyAgentLaunch, ...request }) => ({
      outcome: await mockCreateWebRuntimeSessionTerminal({
        ...request,
        ...(request.preparedAgentCommand ? await legacyAgentLaunch?.() : {})
      })
    })
  )
  const { useTabAgentMenuLaunch } = await import('../../../../components/tab-bar/QuickLaunchButton')
  const snapshot = {
    defaultTuiAgent: 'claude',
    disabledTuiAgents: [],
    agentCmdOverrides: { claude: '/host/claude' },
    agentDefaultArgs: { claude: '--permission-mode auto' },
    environmentNames: {},
    permissionMode: 'mixed' as const
  }
  Object.assign(store.settings, {
    agentCmdOverrides: { claude: '/desktop/claude' },
    agentDefaultArgs: { claude: '--model desktop-only-qa' },
    agentLaunchChoices: { claude: { model: 'desktop-only-qa' } },
    activeRuntimeEnvironmentId: 'web-runtime'
  })
  Object.assign(store.repos[0], { executionHostId: 'runtime:web-runtime' })
  mockIsWebRuntimeSessionActive.mockReturnValue(true)
  inventory.settings.mockResolvedValue(snapshot)
  inventory.session.mockResolvedValue({ origin: 'unknown' })
  const row = { agent: 'claude', kind: 'cli', executionHostId: 'runtime:web-runtime' } as const
  const menu: NewTabAgentMenuModel = {
    state: 'settled',
    rows: [row],
    defaultTuiAgent: 'claude',
    detection: {
      detectedIds: ['claude'],
      isLoading: false,
      isRefreshing: false,
      detectionFailed: false,
      needsServerUpdate: false,
      refresh: async () => ['claude']
    },
    pickerContext: {
      workspace: { kind: 'git-worktree', worktreeId: 'wt-1' },
      executionHostId: row.executionHostId,
      key: 'qa-history-host',
      settings: null
    }
  }
  function Panel({ open }: { open: boolean }) {
    const entry = useAgentPickerInventoryEntries(
      useAgentLaunchPickerInventorySource('wt-1', menu, open)
    )[0]
    const draftScope = useAgentPickerDraftScope()
    const setup = useAgentPickerSetup({ entry, draftScope, open })
    const launch = useTabAgentMenuLaunch({
      worktreeId: 'wt-1',
      groupId: 'group-1',
      onFocusTerminal: () => {}
    })
    return open && setup.ready
      ? createElement(
          TooltipProvider,
          null,
          createElement(AgentLaunchSetupPanel, {
            entry,
            draft: setup.draft,
            getDraft: setup.getDraft,
            onDraftChange: setup.change,
            onUse: (draft) => {
              if (setup.accept(draft)) {
                launch(row, draft, entry)
              }
            }
          })
        )
      : null
  }
  const view = render(createElement(Panel, { open: true }))
  await act(async () => {})
  async function start() {
    mockCreateWebRuntimeSessionTerminal.mockClear()
    fireEvent.click(view.getByText('Launch terminal'))
    await act(async () => {})
    const request = mockCreateWebRuntimeSessionTerminal.mock.calls[0]?.[0]
    expect(request).toBeDefined()
    expect(JSON.stringify(request)).not.toContain('desktop-only-qa')
    expect(request).not.toHaveProperty('command')
    return request!
  }
  const pristine = await start()
  expect(pristine).not.toHaveProperty('agentArgs')
  view.rerender(createElement(Panel, { open: false }))
  view.rerender(createElement(Panel, { open: true }))
  await act(async () => {})
  if (!view.queryByLabelText('Arguments')) {
    fireEvent.click(view.getByLabelText('Toggle Arguments'))
  }
  fireEvent.change(view.getByLabelText('Arguments'), { target: { value: '--add-dir /tmp' } })
  const edited = await start()
  expect(edited.agentArgs).toBe('--permission-mode auto --add-dir /tmp')
  view.rerender(createElement(Panel, { open: false }))
  view.rerender(createElement(Panel, { open: true }))
  await act(async () => {})
  const reopened = await start()
  expect(reopened.agentArgs).toBe('--permission-mode auto --add-dir /tmp')
})

it.each(['claude', 'codex'] as const)(
  'passes %s speed through the real picker-to-terminal compiler',
  async (agent) => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const { agentPickerDraft, agentPickerLaunchInputs } =
      await import('../../../../../../shared/agent-launch/picker/agent-launch-picker')
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
    const draft = applyAgentPickerEdit(entry, agentPickerDraft(entry), {
      kind: 'speed',
      key: agent === 'claude' ? 'fastMode' : 'serviceTier',
      value: agent === 'claude' ? 'true' : 'account_fast_v9',
      model: entry.structured.model
    })
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
    if (agent === 'codex') {
      const explicit = applyAgentPickerEdit(entry, draft, {
        kind: 'choice',
        patch: { model: 'account-model' }
      })
      mockCreateTab.mockClear()
      launchAgentInNewTab({
        requestId: 'picker-explicit-equal-model',
        agent,
        worktreeId: 'wt-1',
        requestedSurface: 'terminal',
        ...agentPickerLaunchInputs({ ...explicit, surface: 'terminal' }, entry)
      })
      expect(queuedStartups()[0]?.command).toContain("'-m' 'account-model'")
    }
  }
)

it.each(['claude', 'codex'] as const)(
  'keeps failed %s defaults unknown through acquisition, controls, projection and actual dispatch, then wakes to a permission-preserving edit',
  async (agent) => {
    const { projectAgentLaunchSettings } =
      await import('../../../../../../shared/agent-launch/choices/agent-launch-settings')
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
      const entries = useAgentPickerInventoryEntries(
        useAgentLaunchPickerInventorySource('wt-1', menu, open)
      )
      current = entries[0]
      const draftScope = useAgentPickerDraftScope()
      const setup = useAgentPickerSetup({ entry: current, draftScope, open })
      return open && setup.ready
        ? createElement(
            TooltipProvider,
            null,
            createElement(AgentLaunchSetupPanel, {
              key: current.ownerKey,
              entry: current,
              draft: setup.draft,
              getDraft: setup.getDraft,
              onDraftChange: setup.change,
              onUse: (draft) => {
                if (setup.accept({ ...draft, surface: setup.draft.surface })) {
                  launches.push(draft)
                }
              }
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
        applyAgentPickerEdit(entry, draft, { kind: 'arguments', text: '--add-dir src' }),
        applyAgentPickerEdit(entry, draft, { kind: 'permission', value: 'full-access' }),
        applyAgentPickerEdit(entry, draft, {
          kind: 'speed',
          key: agent === 'claude' ? 'fastMode' : 'serviceTier',
          value: agent === 'claude' ? 'true' : 'priority'
        })
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
      const removed = applyAgentPickerEdit(current!, knownDraft, {
        kind: 'remove-chip',
        key: 'permissionMode'
      })
      expect(
        agentPickerLaunchInputs({ ...removed, surface: 'terminal' }, current!).agentArgs
      ).not.toContain(agent === 'claude' ? '--permission-mode' : '-a on-request')
    } finally {
      cleanup()
    }
  }
)
