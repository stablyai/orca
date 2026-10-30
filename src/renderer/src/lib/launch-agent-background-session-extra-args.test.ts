import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentBackgroundSessionTestState,
  resetAgentBackgroundSessionTestHarness,
  useRemoteAgentBackgroundRuntime
} from '@/lib/agent-background-session-test-state'

const mockSpawn = vi.fn()
const mockKill = vi.fn()
const mockWrite = vi.fn()
const mockRuntimeEnvironmentCall = vi.fn()
const mockRuntimeEnvironmentTransportCall = vi.fn()
const mockRuntimeEnvironmentSubscribe = vi.fn()
const mockCreateTab = vi.fn()
const mockSetTabCustomTitle = vi.fn()
const mockUpdateTabPtyId = vi.fn()
const mockCloseTab = vi.fn()
const mockSetTabLayout = vi.fn()
const mockRegisterAgentLaunchConfig = vi.fn()
const mockRegisterEagerPtyBuffer = vi.fn()
const mockSubscribeToPtyData = vi.fn()
const mockSubscribeToPtyExit = vi.fn()
const mockPasteDraftWhenAgentReady = vi.fn()
const mockDispatchEvent = vi.fn()
const mockGetAgentLaunchPlatformForRepo = vi.fn<() => NodeJS.Platform>()
const state = createAgentBackgroundSessionTestState({
  createTab: mockCreateTab,
  setTabCustomTitle: mockSetTabCustomTitle,
  updateTabPtyId: mockUpdateTabPtyId,
  closeTab: mockCloseTab,
  setTabLayout: mockSetTabLayout,
  registerAgentLaunchConfig: mockRegisterAgentLaunchConfig
})
let currentStoreState = state

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => currentStoreState,
    subscribe: vi.fn(() => () => {})
  }
}))

// Why: the background mount's sleeping-agent scan reads store state these launches never seed.
vi.mock('@/lib/sleeping-agent-wake-requests', () => ({ requestSleepingAgentWakeOnMount: vi.fn() }))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/lib/execution-host-facts', async (importOriginal) => {
  const hostFact = () => ({
    kind: 'known' as const,
    platform: mockGetAgentLaunchPlatformForRepo(),
    hostKind: 'local' as const
  })
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRepoExecutionHostPlatform: hostFact,
    resolveWorktreeExecutionHostPlatform: hostFact
  }
})

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: mockRegisterEagerPtyBuffer,
  subscribeToPtyExit: mockSubscribeToPtyExit
}))

vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: mockSubscribeToPtyData
}))

describe('launchAgentBackgroundSession with automation extras', () => {
  beforeEach(() => {
    currentStoreState = state
    resetAgentBackgroundSessionTestHarness({
      state,
      createTab: mockCreateTab,
      closeTab: mockCloseTab,
      getLaunchPlatform: mockGetAgentLaunchPlatformForRepo,
      runtimeCall: mockRuntimeEnvironmentCall,
      runtimeTransportCall: mockRuntimeEnvironmentTransportCall,
      runtimeSubscribe: mockRuntimeEnvironmentSubscribe,
      subscribeToData: mockSubscribeToPtyData,
      subscribeToExit: mockSubscribeToPtyExit,
      setTabLayout: mockSetTabLayout,
      updateTabPtyId: mockUpdateTabPtyId,
      dispatchEvent: mockDispatchEvent,
      kill: mockKill,
      spawn: mockSpawn,
      write: mockWrite
    })
  })

  it('fails before reserving a tab or spawning when the extras are refused', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')

    await expect(
      launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'run the automation',
        extraAgentArgs: '--permission-mode bypassPermissions'
      })
    ).rejects.toThrow('"--permission-mode"')
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockRegisterAgentLaunchConfig).not.toHaveBeenCalled()
  })

  it('suppresses Codex updates for a desktop automation without saving the override', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')
    await launchAgentBackgroundSession({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
    })
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining('check_for_update_on_startup=false'),
        launchConfig: expect.objectContaining({
          agentCommand: expect.not.stringContaining('check_for_update_on_startup')
        })
      })
    )
  })

  it('marks paired-server launches unattended even when their prompt is pasted later', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')
    useRemoteAgentBackgroundRuntime(state)
    await launchAgentBackgroundSession({
      agent: 'aider',
      worktreeId: 'wt-1',
      prompt: 'run the automation'
    })
    expect(mockRuntimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.createAgentSession',
        params: expect.objectContaining({ agent: 'aider', promptDelivery: 'auto-submit' })
      })
    )
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('refuses a client-side launch that would drop extras on a paired server', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')
    useRemoteAgentBackgroundRuntime(state)

    await expect(
      launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'run the automation',
        extraAgentArgs: '--model opus'
      })
    ).rejects.toThrow("Extra arguments can't be applied to a paired server's workspace from here.")
    expect(mockRuntimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockRegisterAgentLaunchConfig).not.toHaveBeenCalled()
  })
})
