// @vitest-environment happy-dom
import userEvent from '@testing-library/user-event'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { normalizeNativeChatProviderChoices } from '../../../../shared/native-chat/native-chat-providers'
import { nativeChatPreferenceFor } from '../../../../shared/structured-native-chat-launch-route'
import { installManagedRuntime } from '@/runtime/managed-runtime-install-status'
import { buildNewTabAgentMenuRows } from '@/lib/new-tab-agent-menu-rows'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { ManagedRuntimeInstallObservation } from '@/runtime/use-managed-runtime-install'
import type * as HostChatProgramModule from '@/lib/host-chat-program'
import type * as ManagedRuntimeInstallModule from '@/runtime/managed-runtime-install-status'
import type * as SignInAreaModule from './AntigravityProviderSignInArea'
import { TooltipProvider } from '../ui/tooltip'
import { AgentCatalogRow } from './AgentCatalogRow'
import { AgentLaunchSettingsCatalog } from './AgentLaunchSettingsCatalog'
import { buildAgentOpensAs, saveNativeChatProviderChoice } from './native-chat-provider-choice'

const store = vi.hoisted(
  (): { settings: unknown; localDetectedAgentIdsByContext: { host: TuiAgent[] | null } } => ({
    settings: null,
    localDetectedAgentIdsByContext: { host: ['claude'] }
  })
)
const inventory = vi.hoisted(
  (): {
    detected: TuiAgent[] | null
    failed: boolean
    chatAvailable: boolean
    nativePrograms: TuiAgent[]
  } => ({
    detected: ['claude'],
    failed: false,
    chatAvailable: true,
    nativePrograms: []
  })
)
const runtime = vi.hoisted((): { current: ManagedRuntimeInstallObservation } => ({
  current: { kind: 'pending' }
}))
vi.mock('../../store', () => ({
  useAppStore: Object.assign((selector: (value: unknown) => unknown) => selector(store), {
    getState: () => store
  })
}))
vi.mock('@/lib/chat-provider-agents', () => ({
  chatProviderAgents: () => ['claude', 'codex', 'antigravity'],
  useHostStructuredAgentsVersion: () => 0
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: inventory.detected,
    detectionFailed: inventory.failed,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))
vi.mock('@/lib/host-chat-program-acquisition', () => ({ useChatProgramFacts: () => {} }))
vi.mock('@/lib/host-chat-program', async (importOriginal) => ({
  ...(await importOriginal<typeof HostChatProgramModule>()),
  agentChoiceOpensAsChat: () => false,
  resolveChatProgramContext: (_state: unknown, workspace: { runtimeEnvironmentId?: string }) => ({
    executionHostId: workspace.runtimeEnvironmentId
      ? `runtime:${workspace.runtimeEnvironmentId}`
      : 'local',
    hostCapabilities: [],
    runtimeId: null
  }),
  // The host publishes Antigravity's downloaded chat program; its agy CLI is not installed.
  readChatProgram: (_store: unknown, agent: TuiAgent) =>
    (agent === 'antigravity' && inventory.chatAvailable) || inventory.nativePrograms.includes(agent)
      ? 'available'
      : 'missing'
}))
vi.mock('@/runtime/host-structured-agents', () => ({
  readHostStructuredAgents: () => [{ agent: 'antigravity', managedRuntime: true }]
}))
vi.mock('@/runtime/managed-runtime-install-status', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedRuntimeInstallModule>()),
  installManagedRuntime: vi.fn(async () => {})
}))
vi.mock('@/runtime/use-managed-runtime-install', () => ({
  useManagedRuntimeInstall: () => runtime.current
}))
vi.mock('./AntigravityChatSignInRow', () => ({ useAntigravityChatSignIn: () => ({ flow: null }) }))
vi.mock('./AntigravityProviderSignInArea', async (importOriginal) => ({
  ...(await importOriginal<typeof SignInAreaModule>()),
  AntigravityProviderSignInArea: () => <p>Antigravity account</p>
}))
beforeEach(() => {
  inventory.detected = ['claude']
  inventory.failed = false
  inventory.chatAvailable = true
  inventory.nativePrograms = []
  store.localDetectedAgentIdsByContext.host = ['claude']
  runtime.current = { kind: 'pending' }
  vi.stubGlobal('api', { platform: { get: () => ({ platform: 'darwin' }) } })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderRow(
  agent: TuiAgent,
  settings: ReturnType<typeof createGlobalSettingsFixture>,
  cliDetected: boolean,
  chatRuntime?: React.ReactNode
) {
  const updateSettings = vi.fn()
  store.settings = settings
  const label = agent === 'antigravity' ? 'Antigravity' : agent === 'codex' ? 'Codex' : 'Claude'
  render(
    <AgentCatalogRow
      agentId={agent}
      label={label}
      homepageUrl="https://example.com"
      defaultCmd={agent}
      defaultArgs=""
      defaultEnv={{}}
      isDetected={cliDetected}
      isEnabled
      isDefault={false}
      cmdOverride={undefined}
      argsOverride=""
      envOverride={{}}
      onSetDefault={vi.fn()}
      onSetEnabled={vi.fn()}
      onSaveOverride={vi.fn()}
      onSaveArgs={vi.fn()}
      onSaveEnv={vi.fn()}
      opensAs={buildAgentOpensAs({
        agent,
        cliDetected,
        chatProgramHere: !cliDetected,
        settings,
        updateSettings
      })}
      chatRuntime={chatRuntime}
    />,
    { wrapper: TooltipProvider }
  )
  return updateSettings
}

const checked = (name: string): string | null | undefined =>
  screen.getByRole('radiogroup', { name }).querySelector('[aria-checked="true"]')?.textContent

describe('agent row chat or CLI', () => {
  it.each([
    { agentDefaultSurface: undefined, override: undefined, expected: 'CLI' },
    { agentDefaultSurface: 'terminal', override: undefined, expected: 'CLI' },
    { agentDefaultSurface: 'chat', override: undefined, expected: 'Chat' },
    { agentDefaultSurface: 'chat', override: false, expected: 'CLI' },
    { agentDefaultSurface: 'terminal', override: true, expected: 'Chat' }
  ] as const)(
    'uses default $agentDefaultSurface and override $override in the agent row',
    ({ agentDefaultSurface, override, expected }) => {
      renderRow(
        'codex',
        createGlobalSettingsFixture({
          agentDefaultSurface,
          nativeChatProviders: override === undefined ? {} : { codex: override }
        }),
        true
      )
      expect(checked('Open Codex as')).toBe(expected)
    }
  )

  it('offers only Chat for an agent whose chat runs without its CLI', () => {
    const updateSettings = renderRow(
      'antigravity',
      createGlobalSettingsFixture({ agentDefaultSurface: 'chat' }),
      false
    )
    expect(checked('Open Antigravity as')).toBe('Chat')
    const cli = screen.getByRole('radio', { name: 'CLI' })
    expect(cli.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(cli)
    expect(updateSettings).not.toHaveBeenCalled()
    // It is installed for chat, so the row is not dimmed like an uninstalled agent.
    expect(document.querySelector('.opacity-70')).toBeNull()
  })

  it('offers the inherited Terminal choice on fresh installs and no choice for a disabled agent', () => {
    renderRow('claude', createGlobalSettingsFixture(), true)
    expect(checked('Open Claude as')).toBe('CLI')
    cleanup()
    renderRow(
      'claude',
      createGlobalSettingsFixture({ agentDefaultSurface: 'chat', disabledTuiAgents: ['claude'] }),
      true
    )
    expect(screen.queryByRole('radiogroup', { name: 'Open Claude as' })).toBeNull()
  })

  it('keeps Antigravity setup expanded from first install through its installed-row transition', async () => {
    runtime.current = {
      kind: 'active',
      subject: { target: { kind: 'local' }, runtimeId: null, agent: 'antigravity' },
      removable: true,
      snapshot: {
        kind: 'known',
        state: {
          agent: 'antigravity',
          revision: 1,
          available: true,
          version: '1',
          installedVersion: null,
          installedCurrent: false,
          operation: null,
          source: null
        }
      }
    }
    inventory.detected = null
    inventory.failed = true
    inventory.chatAvailable = false
    const settings = createGlobalSettingsFixture({ agentDefaultSurface: 'chat' })
    store.settings = settings
    const element = () => (
      <AgentLaunchSettingsCatalog
        settings={projectAgentLaunchSettings(settings, 'darwin')}
        mutate={vi.fn(async () => {})}
        detectionTarget={{ kind: 'local' }}
        hostName={null}
        renderPermissions={() => null}
        local={{ settings, updateSettings: vi.fn(), saveEnvironment: vi.fn(async () => {}) }}
      />
    )
    const view = render(element(), { wrapper: TooltipProvider })
    expect(screen.queryByText('Chat runtime')).toBeNull()
    const row = screen.getByRole('radiogroup', { name: 'Open Antigravity as' }).closest('.py-3')
    if (!(row instanceof HTMLElement)) {
      throw new Error('Antigravity row is missing')
    }
    fireEvent.click(within(row).getByRole('button', { name: 'Expand agent settings' }))
    expect(screen.getByText('Chat runtime')).toBeTruthy()
    expect(screen.queryByText('Antigravity account')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    await vi.waitFor(() =>
      expect(installManagedRuntime).toHaveBeenCalledWith({
        target: { kind: 'local' },
        runtimeId: null,
        agent: 'antigravity'
      })
    )
    if (runtime.current.kind !== 'active' || runtime.current.snapshot.kind !== 'known') {
      throw new Error('Managed runtime snapshot is missing')
    }
    Object.assign(runtime.current.snapshot.state, {
      revision: 2,
      source: 'managed',
      installedVersion: '1',
      installedCurrent: true
    })
    view.rerender(element())
    expect(screen.getByText('Antigravity account')).toBeTruthy()
    inventory.chatAvailable = true
    view.rerender(element())
    expect(screen.getByRole('radiogroup', { name: 'Open Antigravity as' }).closest('.py-3')).toBe(
      row
    )
    expect(document.getElementById('agents-installed')?.textContent).toContain('Antigravity')
    expect(within(row).getByRole('button', { name: 'Collapse agent settings' })).toBeTruthy()
    expect(
      row.compareDocumentPosition(screen.getByRole('heading', { name: /Available to install/ })) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).not.toBe(0)
    expect(within(row).getByRole('status').textContent).toContain('Installed')
    expect(screen.getByText('Antigravity account')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Collapse agent settings' }))
    inventory.chatAvailable = false
    view.rerender(element())
    expect(screen.queryByText('Antigravity account')).toBeNull()
    expect(screen.getByRole('radiogroup', { name: 'Open Antigravity as' }).closest('.py-3')).toBe(
      row
    )
  })

  it('lists an agent whose chat runs without its CLI as installed, with Chat only', () => {
    vi.stubGlobal('api', { platform: { get: () => ({ platform: 'darwin' }) } })
    const settings = createGlobalSettingsFixture({ agentDefaultSurface: 'chat' })
    store.settings = settings
    render(
      <AgentLaunchSettingsCatalog
        settings={projectAgentLaunchSettings(settings, 'darwin')}
        mutate={vi.fn(async () => {})}
        detectionTarget={{ kind: 'local' }}
        hostName={null}
        renderPermissions={() => null}
        local={{ settings, updateSettings: vi.fn(), saveEnvironment: vi.fn(async () => {}) }}
      />,
      { wrapper: TooltipProvider }
    )
    const installed = document.getElementById('agents-installed')
    expect(installed?.textContent).toContain('Antigravity')
    expect(checked('Open Antigravity as')).toBe('Chat')
    const group = screen.getByRole('radiogroup', { name: 'Open Antigravity as' })
    expect(group.querySelector('[aria-checked="false"]')?.getAttribute('aria-disabled')).toBe(
      'true'
    )
    const row = group.closest('.py-3')
    if (!(row instanceof HTMLElement)) {
      throw new Error('Missing native-only row')
    }
    fireEvent.click(within(row).getByRole('button', { name: 'Expand agent settings' }))
    expect(within(row).getByText('Model')).toBeTruthy()
    expect(within(row).getByText('Reasoning effort')).toBeTruthy()
    expect(within(row).queryByRole('textbox', { name: 'Arguments' })).toBeNull()
    expect(within(row).queryByRole('textbox', { name: 'Command' })).toBeNull()
    expect(checked('Open Claude as')).toBe('Chat')
    expect(checked('Open Codex as')).toBe('Chat')
    vi.unstubAllGlobals()
  })

  it('retains saved client choices through missing inventory and writes the preference paired launches consume', async () => {
    for (const priorChoice of [false, true, undefined]) {
      const settings = createGlobalSettingsFixture({
        agentDefaultSurface: 'chat',
        defaultTuiAgent: 'codex',
        nativeChatProviders: normalizeNativeChatProviderChoices(
          JSON.parse(JSON.stringify({ claude: false, codex: priorChoice }))
        )
      })
      store.settings = settings
      const updateSettings = vi.fn(async (updates: Partial<GlobalSettings>) => {
        Object.assign(settings, updates)
      })
      const element = () => (
        <AgentLaunchSettingsCatalog
          settings={projectAgentLaunchSettings(settings, 'darwin')}
          mutate={vi.fn(async () => {})}
          detectionTarget={{ kind: 'local' }}
          hostName={null}
          renderPermissions={() => null}
          local={{ settings, updateSettings, saveEnvironment: vi.fn(async () => {}) }}
        />
      )
      inventory.detected = null
      inventory.chatAvailable = false
      const view = render(element(), { wrapper: TooltipProvider })
      const pairedRows = () =>
        buildNewTabAgentMenuRows({
          settings,
          detectedOnHost: ['codex'],
          chatAgents: ['codex'],
          hostChatAnswer: () => 'yes',
          chatProgram: () => 'available'
        })
      for (const observation of [
        { detected: null, failed: false },
        { detected: null, failed: true },
        { detected: [], failed: false },
        { detected: ['claude', 'codex'], failed: false },
        { detected: ['claude'], failed: false }
      ] satisfies { detected: TuiAgent[] | null; failed: boolean }[]) {
        Object.assign(inventory, observation)
        view.rerender(element())
        expect(checked('Open Codex as')).toBe(priorChoice === false ? 'CLI' : 'Chat')
        expect(
          within(screen.getByRole('radiogroup', { name: 'Open Codex as' }))
            .getByRole('radio', { name: 'CLI' })
            .getAttribute('aria-disabled')
        ).not.toBe('true')
        expect(nativeChatPreferenceFor(settings, 'codex')).toBe(priorChoice !== false)
        expect(updateSettings).not.toHaveBeenCalled()
        expect(settings.defaultTuiAgent).toBe('codex')
      }
      expect(pairedRows()).toEqual(
        priorChoice === false
          ? [{ kind: 'cli', agent: 'codex', chat: true }]
          : [{ kind: 'chat', agent: 'codex' }]
      )
      fireEvent.click(
        within(screen.getByRole('radiogroup', { name: 'Open Codex as' })).getByRole('radio', {
          name: priorChoice === false ? 'Chat' : 'CLI'
        })
      )
      await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledOnce())
      view.rerender(element())
      expect(settings.nativeChatProviders).toEqual(
        priorChoice === false ? { claude: false } : { claude: false, codex: false }
      )
      expect(pairedRows()).toEqual(
        priorChoice === false
          ? [{ kind: 'chat', agent: 'codex' }]
          : [{ kind: 'cli', agent: 'codex', chat: true }]
      )
      cleanup()
    }
  })

  it('serializes choices from different rows while an inventory update arrives during the save', async () => {
    const settings = createGlobalSettingsFixture({ agentDefaultSurface: 'chat' })
    store.settings = settings
    const save = Promise.withResolvers<void>()
    const updateSettings = vi.fn(async (updates: Partial<GlobalSettings>) => {
      await save.promise
      Object.assign(settings, updates)
    })
    const element = () => (
      <AgentLaunchSettingsCatalog
        settings={projectAgentLaunchSettings(settings, 'darwin')}
        mutate={vi.fn(async () => {})}
        detectionTarget={{ kind: 'local' }}
        hostName={null}
        renderPermissions={() => null}
        local={{ settings, updateSettings, saveEnvironment: vi.fn(async () => {}) }}
      />
    )
    const view = render(element(), { wrapper: TooltipProvider })
    const cli = (label: string) =>
      within(screen.getByRole('radiogroup', { name: `Open ${label} as` })).getByRole('radio', {
        name: 'CLI'
      })
    fireEvent.click(cli('Claude'))
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledOnce())
    fireEvent.click(cli('Codex'))
    inventory.detected = []
    view.rerender(element())
    expect(updateSettings).toHaveBeenCalledOnce()
    save.resolve()
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2))
    expect(settings.nativeChatProviders).toEqual({ claude: false, codex: false })
  })

  it('uses native facts for the computer-wide mode and contextual facts for CLI settings', async () => {
    inventory.nativePrograms = ['claude']
    const inventories: {
      native: TuiAgent[] | null
      contextual: TuiAgent[]
      cliDisabled: boolean
    }[] = [
      { native: ['claude'], contextual: [], cliDisabled: false },
      { native: [], contextual: ['claude'], cliDisabled: true },
      { native: null, contextual: ['claude'], cliDisabled: false }
    ]
    for (const { native, contextual, cliDisabled } of inventories) {
      inventory.detected = contextual
      store.localDetectedAgentIdsByContext.host = native
      const settings = createGlobalSettingsFixture({ agentDefaultSurface: 'chat' })
      store.settings = settings
      const updateSettings = vi.fn(async (updates: Partial<GlobalSettings>) => {
        Object.assign(settings, updates)
      })
      render(
        <AgentLaunchSettingsCatalog
          settings={projectAgentLaunchSettings(settings, 'win32')}
          mutate={vi.fn(async () => {})}
          detectionTarget={{ kind: 'local' }}
          hostName={null}
          renderPermissions={() => null}
          local={{ settings, updateSettings, saveEnvironment: vi.fn(async () => {}) }}
        />,
        { wrapper: TooltipProvider }
      )
      const group = screen.getByRole('radiogroup', { name: 'Open Claude as' })
      const cli = within(group).getByRole('radio', { name: 'CLI' })
      expect(cli.getAttribute('aria-disabled') === 'true').toBe(cliDisabled)
      const row = group.closest('.py-3')
      if (!(row instanceof HTMLElement)) {
        throw new Error('Claude row is missing')
      }
      expect(within(row).queryByRole('button', { name: 'Default' }) !== null).toBe(
        contextual.includes('claude')
      )
      fireEvent.click(cli)
      if (cliDisabled) {
        expect(updateSettings).not.toHaveBeenCalled()
      } else {
        await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledOnce())
        expect(
          buildNewTabAgentMenuRows({
            settings,
            detectedOnHost: native,
            chatAgents: ['claude'],
            hostChatAnswer: () => 'yes',
            chatProgram: () => 'available'
          })
        ).toEqual(native?.includes('claude') ? [{ kind: 'cli', agent: 'claude', chat: true }] : [])
      }
      cleanup()
    }
  })
})

it.each(['chat', 'terminal'] as const)(
  'stores only opposite overrides to default %s and retains saved IDs',
  async (agentDefaultSurface) => {
    const settings = createGlobalSettingsFixture({
      agentDefaultSurface,
      nativeChatProviders: { 'saved-agent': true, codex: false }
    })
    store.settings = settings
    const updateSettings = vi.fn()
    const write = (on: boolean) =>
      saveNativeChatProviderChoice({
        agent: 'claude',
        on,
        fallbackSettings: settings,
        updateSettings
      })
    await write(agentDefaultSurface !== 'chat')
    expect(updateSettings).toHaveBeenLastCalledWith({
      nativeChatProviders: {
        'saved-agent': true,
        codex: false,
        claude: agentDefaultSurface !== 'chat'
      }
    })
    await write(agentDefaultSurface === 'chat')
    expect(updateSettings).toHaveBeenLastCalledWith({
      nativeChatProviders: { 'saved-agent': true, codex: false }
    })
  }
)

it('offers the selected paired native-only program editor and writes effort without CLI controls', async () => {
  inventory.detected = []
  store.localDetectedAgentIdsByContext.host = ['claude', 'antigravity']
  const settings = createGlobalSettingsFixture({
    agentLaunchChoices: {},
    agentPermissionDefault: 'own'
  })
  store.settings = settings
  const mutate = vi.fn(async () => {})
  const element = () => (
    <AgentLaunchSettingsCatalog
      settings={projectAgentLaunchSettings(settings, 'linux')}
      mutate={mutate}
      detectionTarget={{ kind: 'runtime', environmentId: 'paired-native' }}
      hostName="Paired"
      renderPermissions={() => null}
    />
  )
  const view = render(element(), { wrapper: TooltipProvider })
  const label = screen.getByText('Antigravity')
  const row = label.closest('.py-3')
  if (!(row instanceof HTMLElement)) {
    throw new Error('Missing paired native-only row')
  }
  fireEvent.click(within(row).getByRole('button', { name: 'Expand agent settings' }))
  expect(within(row).getByText('Model')).toBeTruthy()
  expect(within(row).queryByRole('textbox', { name: 'Arguments' })).toBeNull()
  expect(within(row).queryByRole('textbox', { name: 'Command' })).toBeNull()
  expect(screen.queryByRole('radiogroup', { name: 'Open Antigravity as' })).toBeNull()
  const effort = within(row).getByRole('button', { name: 'Reasoning effort: Default' })
  await userEvent.click(effort)
  const option = screen.getAllByRole('menuitemradio').find((item) => item.textContent === 'High')
  if (!option) {
    throw new Error('Missing paired effort option')
  }
  fireEvent.click(option)
  await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce())
  expect(mutate.mock.calls[0]).toEqual([
    expect.objectContaining({
      type: 'launch-choices',
      agent: 'antigravity',
      patch: { options: { effort: 'high' } }
    })
  ])
  inventory.chatAvailable = false
  view.rerender(element())
  expect(within(row).queryByText('Model')).toBeNull()
})
