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

  it('takes the global selection by default', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(mockCreateTab.mock.calls[0]?.[3]).not.toHaveProperty('activate')
    expect(mockSetActiveTabType).toHaveBeenCalledExactlyOnceWith('terminal')
  })

  it('honours the chat default in a floating launch while keeping it out of the global selection', async () => {
    store.settings = placementSettings({
      experimentalNativeChat: true,
      experimentalStructuredNativeChat: true,
      openAgentTabsInChatByDefault: true,
      nativeChatSessionOptions: {
        codex: {
          model: 'gpt-5.2-codex',
          valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
        }
      }
    })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'codex',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activate: false
    })

    // Why: the floating workspace selects within its own group; activating here would move the
    // main window's active tab to a tab it does not show.
    expect(mockCreateTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      undefined,
      undefined,
      {
        launchAgent: 'codex',
        activate: false,
        viewMode: 'chat'
      }
    )
    expect(mockSetActiveTabType).not.toHaveBeenCalled()
    // Why: the panel hosts the chat pane itself, so the launch carries the user's model/effort
    // preferences the same way a main-window launch does.
    expect(mockSeedNativeChatAppliedSessionOptions).toHaveBeenCalledWith('tab-1', 'codex', {
      model: 'gpt-5.2-codex',
      effort: 'medium'
    })
  })
})
