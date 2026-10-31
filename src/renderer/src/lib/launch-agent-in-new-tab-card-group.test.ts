import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'

const {
  mockCreateTab,
  mockLaunchAgentInWebHostTab,
  mockIsWebRuntimeSessionActive,
  mockLaunchStructuredAgentFromNewTab,
  mockResolveAgentLaunchGroupId
} = vi.hoisted(() => ({
  mockCreateTab: vi.fn(),
  mockLaunchAgentInWebHostTab: vi.fn(),
  mockIsWebRuntimeSessionActive: vi.fn(),
  mockLaunchStructuredAgentFromNewTab: vi.fn(),
  mockResolveAgentLaunchGroupId:
    vi.fn<(worktreeId: string, callerGroupId: string | undefined) => string | undefined>()
}))

// Why annotated consts rather than casts: this repo forbids type assertions, and an empty
// literal inside the double would otherwise infer a uselessly narrow type.
const nullableRuntimeEnvironmentId: string | null = null
const emptyOpenFiles: { id: string; worktreeId: string }[] = []
const emptyBrowserTabs: Record<string, { id: string }[]> = {}
const emptyTabBarOrder: Record<string, string[]> = {}

const store = {
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: nullableRuntimeEnvironmentId
  },
  repos: [],
  allWorktrees: vi.fn(() => []),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: emptyOpenFiles,
  browserTabsByWorktree: emptyBrowserTabs,
  tabBarOrderByWorktree: emptyTabBarOrder,
  resolveAgentLaunchGroupId: mockResolveAgentLaunchGroupId,
  createTab: mockCreateTab,
  queueTabInitialCwd: vi.fn(),
  queueTabStartupCommand: vi.fn(),
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => store }
}))

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdFromState: () => null
}))

vi.mock('../../../shared/native-chat/transcript/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))

vi.mock('@/runtime/web-runtime-session-environment', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isWebRuntimeSessionActive: mockIsWebRuntimeSessionActive
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local',
  runtimeEnvironmentIdOrLocalUnlessTwin: () => 'web-runtime'
}))

vi.mock('@/lib/launch-agent-web-host-tab', () => ({
  launchAgentInWebHostTab: mockLaunchAgentInWebHostTab
}))

vi.mock('@/lib/launch-agent-in-new-tab-structured-route', () => ({
  launchStructuredAgentFromNewTab: mockLaunchStructuredAgentFromNewTab
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (_stored: unknown, terminalIds: string[]) => terminalIds
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: vi.fn()
}))

/** Every abandoned launch below would otherwise leave a registered but empty agent card group. */
describe('launchAgentInNewTab agent card group', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setLocalRuntimeCapabilitiesForTests([])
    mockIsWebRuntimeSessionActive.mockReturnValue(false)
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
    mockResolveAgentLaunchGroupId.mockReturnValue('card-group-1')
    mockLaunchAgentInWebHostTab.mockResolvedValue({ delivered: true, failureNotified: false })
    mockLaunchStructuredAgentFromNewTab.mockReturnValue(null)
  })

  it('resolves the card group once the terminal launch is committed', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1', requestId: 'terminal' })

    expect(mockResolveAgentLaunchGroupId).toHaveBeenCalledTimes(1)
    expect(mockCreateTab).toHaveBeenCalledWith(
      'wt-1',
      'card-group-1',
      undefined,
      expect.objectContaining({ launchAgent: 'codex' })
    )
  })

  it('does not resolve a card group when startup validation rejects the launch', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      requestId: 'terminal',
      agentArgs: '--model "unterminated'
    })

    expect(result).toBeNull()
    expect(mockResolveAgentLaunchGroupId).not.toHaveBeenCalled()
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('does not resolve a card group when the caller cancels the terminal surface', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      requestId: 'terminal',
      beforeSurfaceOpen: () => false
    })

    expect(result).toBeNull()
    expect(mockResolveAgentLaunchGroupId).not.toHaveBeenCalled()
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('does not resolve a card group when the caller cancels a paired host launch', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      requestId: 'terminal',
      beforeSurfaceOpen: () => false
    })

    expect(result).toBeNull()
    expect(mockResolveAgentLaunchGroupId).not.toHaveBeenCalled()
    expect(mockLaunchAgentInWebHostTab).not.toHaveBeenCalled()
  })

  it('resolves the card group once the paired host launch is committed', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1', requestId: 'terminal' })

    expect(mockResolveAgentLaunchGroupId).toHaveBeenCalledTimes(1)
    expect(mockLaunchAgentInWebHostTab).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'card-group-1' })
    )
  })

  it('leaves card group resolution to the provisional tab opener on the structured route', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'caller-group',
      agentSessionLaunchPlan: adoptAgentSessionLaunchVerdict({
        route: 'structured-native-chat',
        requestId: 'chat',
        agent: 'claude',
        worktreeId: 'wt-1'
      })
    })

    expect(result).toBeNull()
    expect(mockResolveAgentLaunchGroupId).not.toHaveBeenCalled()
    expect(mockLaunchStructuredAgentFromNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'caller-group' })
    )
  })
})
