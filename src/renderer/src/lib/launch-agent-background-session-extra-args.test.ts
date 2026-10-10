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

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/lib/agent-launch-platform', () => ({
  getAgentLaunchPlatformForRepo: mockGetAgentLaunchPlatformForRepo
}))

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

  it('merges extras over the default arguments, before the prompt', async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')
    mockSpawn.mockResolvedValue({ id: 'pty-1' })

    await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation',
      extraAgentArgs: '--model opus --add-dir "my docs"'
    })

    expect(mockSpawn.mock.calls[0]?.[0]).toMatchObject({
      command:
        "claude '--dangerously-skip-permissions' '--model' 'opus' '--add-dir' 'my docs' 'run the automation'",
      launchConfig: {
        agentArgs: "'--dangerously-skip-permissions' '--model' 'opus' '--add-dir' 'my docs'"
      }
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
