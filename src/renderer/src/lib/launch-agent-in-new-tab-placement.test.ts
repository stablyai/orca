// Caller-owned placement coverage for launchAgentInNewTab, split from
// launch-agent-in-new-tab.test.ts to keep both files within the lines budget.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

const mockCreateTab = vi.fn()
const mockQueueTabStartupCommand = vi.fn()
const mockSetActiveTabType = vi.fn()
const mockSeedNativeChatAppliedSessionOptions = vi.fn()

type PlacementSettings = {
  agentCmdOverrides: Record<string, string>
  agentDefaultArgs: Record<string, string>
  agentDefaultEnv: Record<string, Record<string, string>>
  activeRuntimeEnvironmentId: string | null
  experimentalNativeChat?: boolean
  experimentalStructuredNativeChat?: boolean
  openAgentTabsInChatByDefault?: boolean
  nativeChatSessionOptions?: Record<
    string,
    { model?: string; valuesByModel?: Record<string, Record<string, string>> }
  >
}

function placementSettings(overrides: Partial<PlacementSettings> = {}): PlacementSettings {
  return {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null,
    ...overrides
  }
}

const store = {
  settings: placementSettings(),
  repos: [],
  allWorktrees: vi.fn(() => []),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [],
  browserTabsByWorktree: {},
  tabBarOrderByWorktree: {},
  createTab: mockCreateTab,
  queueTabInitialCwd: vi.fn(),
  queueTabStartupCommand: mockQueueTabStartupCommand,
  setActiveTabType: mockSetActiveTabType,
  setTabBarOrder: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => store }
}))

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdFromState: () => null
}))

vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: () => false
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local',
  getRuntimeEnvironmentIdForWorktree: () => null
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (_stored: unknown, terminalIds: string[]) => terminalIds
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: mockSeedNativeChatAppliedSessionOptions
}))

describe('launchAgentInNewTab terminal tab activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.settings = placementSettings()
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
  })

  // Why: the store scopes activation to the launch's own workspace, so the floating panel launches
  // like every other caller and cannot move the main window's selection.
  it.each(['wt-1', FLOATING_TERMINAL_WORKTREE_ID])(
    'selects the new tab within %s only',
    async (worktreeId) => {
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      launchAgentInNewTab({ agent: 'codex', worktreeId })

      expect(mockCreateTab.mock.calls[0]?.[3]).not.toHaveProperty('activate')
      expect(mockSetActiveTabType).toHaveBeenCalledExactlyOnceWith('terminal', worktreeId)
    }
  )
})
