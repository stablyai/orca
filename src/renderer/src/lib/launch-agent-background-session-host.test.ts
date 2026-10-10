import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT } from '@/constants/terminal'
import {
  createAgentBackgroundSessionTestState,
  localRuntimeCall,
  resetAgentBackgroundSessionTestHarness
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

describe('a desktop automation run started through its host', () => {
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

  function hostStarts(ptyId: string, incarnationId: string): void {
    localRuntimeCall.mockImplementation(async ({ method }) =>
      method === 'agent.launch'
        ? {
            id: 'desktop-ipc',
            ok: true,
            result: {
              outcome: { kind: 'terminal', handle: 'term_1' },
              worktreeId: 'wt-1',
              receipt: {
                mode: 'terminal',
                preferred: 'terminal',
                reason: 'user_default',
                detail: ''
              },
              backgroundRun: { ptyId, incarnationId }
            },
            _meta: { runtimeId: 'runtime-local' }
          }
        : Promise.reject(new Error(`unexpected ${method}`))
    )
  }

  function hostLaunch(): unknown {
    return localRuntimeCall.mock.calls.find(([call]) => call.method === 'agent.launch')?.[0].params
  }

  it("adopts the host's PTY into the hidden run tab, observed as the window's own", async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')
    hostStarts('pty-host', 'inc-host')

    const result = await launchAgentBackgroundSession({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'run the automation',
      title: 'Nightly audit',
      launchSource: 'unknown'
    })

    expect(mockSpawn).not.toHaveBeenCalled()
    const params = hostLaunch()
    const paneKey = expect.stringMatching(/^[0-9a-f-]+:[0-9a-f-]+$/)
    const tabId = mockCreateTab.mock.calls[0]?.[3]?.id
    expect(params).toMatchObject({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'id:wt-1' },
      prompt: { text: 'run the automation', delivery: 'submit' },
      launchSource: 'unknown',
      paneKey,
      presentation: 'background',
      backgroundRun: { title: 'Nightly audit', launchToken: expect.any(String) }
    })
    expect(params).toMatchObject({ paneKey: expect.stringContaining(`${tabId}:`) })
    expect(params).not.toHaveProperty('operationId')
    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      id: tabId,
      initialPtyId: 'pty-host',
      activate: false,
      recordInteraction: false
    })
    expect(mockRegisterEagerPtyBuffer).toHaveBeenCalledWith(
      'pty-host',
      expect.any(Function),
      'inc-host'
    )
    expect(mockSubscribeToPtyData).toHaveBeenCalledWith('pty-host', expect.any(Function))
    expect(mockDispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
        detail: { worktreeId: 'wt-1', tabIds: [tabId] }
      })
    )
    expect(result).toMatchObject({ tabId, ptyId: 'pty-host' })
  })

  it("pastes a post-start agent's prompt from the window, never through the host", async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')
    hostStarts('pty-host', 'inc-host')

    await launchAgentBackgroundSession({
      agent: 'aider',
      worktreeId: 'wt-1',
      prompt: 'fix the bug'
    })

    expect(hostLaunch()).not.toHaveProperty('prompt')
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'fix the bug', agent: 'aider', submit: true })
    )
  })

  it("fails the run as main's spawn failed, leaving no tab and spawning nothing more", async () => {
    const { launchAgentBackgroundSession } = await import('./launch-agent-background-session')
    localRuntimeCall.mockResolvedValue({
      id: 'desktop-ipc',
      ok: false,
      error: {
        code: 'agent_launch_background_run_spawn_failed',
        message: 'Error: posix_spawnp failed.'
      },
      _meta: { runtimeId: 'runtime-local' }
    })

    await expect(
      launchAgentBackgroundSession({ agent: 'claude', worktreeId: 'wt-1', prompt: 'go' })
    ).rejects.toThrow("Error invoking remote method 'pty:spawn': Error: posix_spawnp failed.")
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockCreateTab).not.toHaveBeenCalled()
  })
})
