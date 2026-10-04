import { vi } from 'vitest'

/**
 * The store double `launchAgentInNewTab` reads, shared by the caller-behaviour suite.
 *
 * Kept beside the funnel rather than copied per file: the caller net spans several test files and
 * every one of them needs the same store surface, so a field the funnel starts reading is added
 * once here instead of drifting between copies.
 */
export type LaunchFunnelSettings = {
  agentCmdOverrides: Record<string, string>
  agentDefaultArgs: Record<string, string>
  agentDefaultEnv: Record<string, Record<string, string>>
  activeRuntimeEnvironmentId: string | null
  terminalWindowsShell?: string
  experimentalNativeChat?: boolean
  experimentalStructuredNativeChat?: boolean
  openAgentTabsInChatByDefault?: boolean
  nativeChatSessionOptions?: Record<
    string,
    { model?: string; valuesByModel?: Record<string, Record<string, string>> }
  >
}

export function launchFunnelSettings(
  overrides: Partial<LaunchFunnelSettings> = {}
): LaunchFunnelSettings {
  return {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null,
    ...overrides
  }
}

export function createLaunchFunnelStore(): {
  settings: LaunchFunnelSettings
  repos: { id: string; connectionId: string | null; path: string }[]
  allWorktrees: ReturnType<typeof vi.fn>
  tabsByWorktree: Record<string, { id: string }[]>
  openFiles: { id: string; worktreeId: string }[]
  browserTabsByWorktree: Record<string, { id: string }[]>
  tabBarOrderByWorktree: Record<string, string[]>
  createTab: ReturnType<typeof vi.fn>
  queueTabInitialCwd: ReturnType<typeof vi.fn>
  queueTabStartupCommand: ReturnType<typeof vi.fn>
  setActiveTabType: ReturnType<typeof vi.fn>
  setTabBarOrder: ReturnType<typeof vi.fn>
  setAgentStatus: ReturnType<typeof vi.fn>
  seedNativeChatLaunchPrompt: ReturnType<typeof vi.fn>
  seedNativeChatLaunchDraft: ReturnType<typeof vi.fn>
  markNativeChatLaunchPromptFailed: ReturnType<typeof vi.fn>
} {
  return {
    settings: launchFunnelSettings(),
    repos: [],
    allWorktrees: vi.fn(() => []),
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
    openFiles: [],
    browserTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    createTab: vi.fn(() => ({ id: 'tab-1' })),
    queueTabInitialCwd: vi.fn(),
    queueTabStartupCommand: vi.fn(),
    setActiveTabType: vi.fn(),
    setTabBarOrder: vi.fn(),
    setAgentStatus: vi.fn(),
    seedNativeChatLaunchPrompt: vi.fn(),
    seedNativeChatLaunchDraft: vi.fn(),
    markNativeChatLaunchPromptFailed: vi.fn()
  }
}

export type LaunchFunnelStore = ReturnType<typeof createLaunchFunnelStore>

export function resetLaunchFunnelStore(
  store: LaunchFunnelStore,
  settingsOverrides: Partial<LaunchFunnelSettings> = {}
): void {
  store.settings = launchFunnelSettings(settingsOverrides)
  store.repos = []
  store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
  store.openFiles = []
  store.browserTabsByWorktree = {}
  store.tabBarOrderByWorktree = {}
  store.createTab.mockReturnValue({ id: 'tab-1' })
}

/** The startup command `queueTabStartupCommand` received, or undefined when no tab was queued. */
export function queuedStartupCommand(store: LaunchFunnelStore): string | undefined {
  return store.queueTabStartupCommand.mock.calls[0]?.[1]?.command
}

/** The whole startup-command payload, for callers that assert more than the command string. */
export function queuedStartupPayload(
  store: LaunchFunnelStore
): Record<string, unknown> | undefined {
  return store.queueTabStartupCommand.mock.calls[0]?.[1]
}

/** The tab-creation options object (`createTab`'s 4th argument). */
export function createdTabOptions(store: LaunchFunnelStore): Record<string, unknown> | undefined {
  return store.createTab.mock.calls[0]?.[3]
}

/** The tab group `createTab` was asked to place the new tab in (its 2nd argument). */
export function createdTabGroupId(store: LaunchFunnelStore): string | undefined {
  return store.createTab.mock.calls[0]?.[1]
}
