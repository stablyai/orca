// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectAgentLaunchSettings } from '../../../../../shared/agent-launch/choices/agent-launch-settings'
import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { ManagedRuntimeInstallObservation } from '@/runtime/hosts/installation/use-managed-runtime-install'
import type * as HostChatProgramModule from '@/lib/host-chat-program'
import type * as ManagedRuntimeInstallModule from '@/runtime/hosts/installation/managed-runtime-install-status'
import type * as SignInAreaModule from '../../../components/provider-accounts/AntigravityProviderSignInArea'
import { TooltipProvider } from '../../../components/ui/tooltip'
import { AgentLaunchSettingsCatalog } from '../../../components/settings/agents/launch/AgentLaunchSettingsCatalog'

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
vi.mock('../../../store/index', () => ({
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
vi.mock('@/runtime/native-chat/agent-catalogs/host-structured-agents', () => ({
  readHostStructuredAgents: () => [{ agent: 'antigravity', managedRuntime: true }]
}))
vi.mock('@/runtime/hosts/installation/managed-runtime-install-status', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedRuntimeInstallModule>()),
  installManagedRuntime: vi.fn(async () => {})
}))
vi.mock('@/runtime/hosts/installation/use-managed-runtime-install', () => ({
  useManagedRuntimeInstall: () => runtime.current
}))
vi.mock('../../../components/provider-accounts/AntigravityChatSignInRow', () => ({
  useAntigravityChatSignIn: () => ({ flow: null })
}))
vi.mock(
  '../../../components/provider-accounts/AntigravityProviderSignInArea',
  async (importOriginal) => ({
    ...(await importOriginal<typeof SignInAreaModule>()),
    AntigravityProviderSignInArea: () => <p>Antigravity account</p>
  })
)
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

describe('agent row chat or CLI', () => {
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
})
