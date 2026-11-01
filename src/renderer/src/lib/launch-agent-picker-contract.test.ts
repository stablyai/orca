import {
  useAgentPickerSetup,
  useAgentPickerDraftScope
} from '../components/agent/agent-launch-picker-drafts'
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
import {
  acceptAgentPickerArguments,
  applyAgentPickerEdit
} from '../../../shared/agent-launch-picker-edits'
import { agentPickerPanelArguments } from '../../../shared/agent-launch-picker-arguments'
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
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: inventory.legacy,
  runtimeEnvironmentSupportsCapability: async () => false
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: inventory.session
}))

describe('picker window launch contract', () => {
  it.each(['claude', 'codex'] as const)(
    'preserves %s permission and model intent through the actual picker-to-terminal compiler',
    async (agent) => {
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
      const { agentPickerChoiceSeeds, agentPickerDraft, agentPickerLaunchInputs } =
        await import('../../../shared/agent-launch-picker')
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
      expect(expectedSearch.command ?? expectedSearch.remote?.command ?? '').toContain('opus')
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

it.each(['claude', 'codex'] as const)(
  'passes %s speed through the real picker-to-terminal compiler',
  async (agent) => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const { agentPickerDraft, agentPickerLaunchInputs } =
      await import('../../../shared/agent-launch-picker')
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
  const selected = applyAgentPickerEdit(entry, agentPickerDraft(entry), {
    kind: 'speed',
    key: 'serviceTier',
    value: tier,
    model: model.id
  })
  const view = agentPickerPanelArguments(entry, selected)
  expect(view.permission).toBeDefined()
  const edited = acceptAgentPickerArguments(
    entry,
    applyAgentPickerEdit(entry, selected, {
      kind: 'arguments',
      text: '--add-dir src'
    })
  )
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
  const standard = acceptAgentPickerArguments(
    entry,
    applyAgentPickerEdit(entry, selected, {
      kind: 'arguments',
      text: '-c service_tier=default --add-dir src'
    })
  )
  expect(standard).toMatchObject({ choices: { options: { serviceTier: 'default' } } })
  expect(
    agentPickerLaunchInputs({ ...standard, surface: 'chat' }, entry).sessionOptions?.serviceTier
  ).toBe('default')
  expect(agentPickerLaunchInputs({ ...standard, surface: 'terminal' }, entry).agentArgs).toContain(
    'service_tier=default'
  )
  expect(view.choices.options?.serviceTier).toBe(tier)
  const removed = applyAgentPickerEdit(entry, selected, { kind: 'remove-chip', key: 'serviceTier' })
  expect(agentPickerPanelArguments(entry, removed).choices.options?.serviceTier).toBe('default')
})

it('conserves quoted Codex string sources through common acceptance and the terminal compiler', async () => {
  const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
  const { tokenizeStartupCommand } = await import('../../../shared/tui-agent-startup-shell')
  const { agentChoiceConfigString } = await import('../../../shared/agent-choice-cli-apply')
  const own: AgentPickerEntry = {
    agent: 'codex',
    label: 'Codex',
    rows: [{ agent: 'codex', kind: 'cli' }],
    surfaces: ['chat', 'terminal'],
    defaultSurface: 'terminal',
    terminal: { permissionMode: 'own' },
    structured: {},
    arguments: '',
    catalog: { origin: 'unknown' }
  }
  for (const [key, scalar] of [
    ['model', 'some-model'],
    ['model', 'true'],
    ['model', '42'],
    ['model', 'a"b'],
    ['model_reasoning_effort', 'high'],
    ['model_reasoning_effort', 'future_effort']
  ]) {
    const operand = `${key}=${JSON.stringify(scalar)}`
    const raw = `-c '${operand}' --search`
    const draft = acceptAgentPickerArguments(
      own,
      applyAgentPickerEdit(own, agentPickerDraft(own), { kind: 'arguments', text: raw })
    )
    const semanticKey = key === 'model' ? 'model' : 'effort'
    expect(agentPickerPanelArguments(own, draft).text).toBe('--search')
    expect(
      agentPickerLaunchInputs({ ...draft, surface: 'chat' }, own).chatSessionOptions?.[semanticKey]
    ).toBe(scalar)
    for (const command of ['codex', 'cx']) {
      store.settings.agentCmdOverrides = { codex: command }
      mockCreateTab.mockClear()
      launchAgentInNewTab({
        requestId: 'quoted-string-source',
        agent: 'codex',
        worktreeId: 'wt-1',
        requestedSurface: 'terminal',
        ...agentPickerLaunchInputs(draft, own)
      })
      const startup = queuedStartups()[0]
      expect(startup?.launchConfig?.agentArgs).toContain(raw)
      const compiled = tokenizeStartupCommand(startup?.command ?? '', 'posix')
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) {
        throw new Error('Expected valid terminal startup')
      }
      expect(compiled.tokens[0]).toBe(command)
      const operands = compiled.tokens.filter((token) => token.startsWith(`${key}=`))
      expect(operands).toEqual([operand])
      expect(agentChoiceConfigString(operands[0].slice(key.length + 1))).toBe(scalar)
    }
  }
})
