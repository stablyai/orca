import { vi } from 'vitest'
import { settleAgentLaunchPaneStart } from './agent-launch-pane-start'

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
  setActiveTabType: ReturnType<typeof vi.fn>
  setTabBarOrder: ReturnType<typeof vi.fn>
  setAgentStatus: ReturnType<typeof vi.fn>
  seedNativeChatLaunchPrompt: ReturnType<typeof vi.fn>
  seedNativeChatLaunchDraft: ReturnType<typeof vi.fn>
  markNativeChatLaunchPromptFailed: ReturnType<typeof vi.fn>
  setTabAgentLaunchPane: ReturnType<typeof vi.fn>
  closeTab: ReturnType<typeof vi.fn>
  readLocalAgentInventory: () => { ids: null; state: 'pending' }
  runtimeDetectedAgentIds: Record<string, never>
  runtimeAgentInventoryOutcome: () => 'pending'
  runtimeAgentDetectionNeedsServerUpdate: Record<string, never>
} {
  const store = {
    settings: launchFunnelSettings(),
    repos: [],
    allWorktrees: vi.fn(() => []),
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
    openFiles: [],
    browserTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    createTab: vi.fn(),
    queueTabInitialCwd: vi.fn(),
    setActiveTabType: vi.fn(),
    setTabBarOrder: vi.fn(),
    setAgentStatus: vi.fn(),
    seedNativeChatLaunchPrompt: vi.fn(),
    seedNativeChatLaunchDraft: vi.fn(),
    markNativeChatLaunchPromptFailed: vi.fn(),
    setTabAgentLaunchPane: vi.fn(),
    closeTab: vi.fn(),
    readLocalAgentInventory: () => ({ ids: null, state: 'pending' as const }),
    runtimeDetectedAgentIds: {},
    runtimeAgentInventoryOutcome: () => 'pending' as const,
    runtimeAgentDetectionNeedsServerUpdate: {}
  }
  store.createTab.mockImplementation(createTabInto(store))
  return store
}

type CreatedTabOptions = {
  id?: string
  initialLeafId?: string
  pendingStartup?: { agentLaunch?: unknown }
}

/** A tab made with its own id joins the workspace, as the real store's does; launches read it back.
 *  A launch tab's pane spawn answers that its agent started, as a mounted pane's would. */
function createTabInto(store: { tabsByWorktree: Record<string, { id: string }[]> }) {
  return (worktreeId: string, _groupId?: string, _x?: unknown, opts?: CreatedTabOptions) => {
    if (!opts?.id) {
      return { id: 'tab-1' }
    }
    const tab = { id: opts.id }
    store.tabsByWorktree[worktreeId] = [...(store.tabsByWorktree[worktreeId] ?? []), tab]
    const { initialLeafId } = opts
    if (opts.pendingStartup?.agentLaunch && initialLeafId) {
      queueMicrotask(() => settleAgentLaunchPaneStart(tab.id, initialLeafId, `${tab.id}-pty`))
    }
    return tab
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
  store.createTab.mockImplementation(createTabInto(store))
}

/** The startup command the window planned for the new tab, or undefined when the host plans it. */
export function queuedStartupCommand(store: LaunchFunnelStore): string | undefined {
  return queuedStartupPayload(store)?.command
}

/** The whole window-planned startup payload, for callers that assert more than the command string. */
export function queuedStartupPayload(
  store: LaunchFunnelStore
): { command?: string; [key: string]: unknown } | undefined {
  const options: { pendingStartup?: { command?: string; agentLaunch?: unknown } } =
    store.createTab.mock.calls[0]?.[3] ?? {}
  return options.pendingStartup?.agentLaunch ? undefined : options.pendingStartup
}

/** The tab-creation options object (`createTab`'s 4th argument). */
export function createdTabOptions(store: LaunchFunnelStore): Record<string, unknown> | undefined {
  return store.createTab.mock.calls[0]?.[3]
}

/** The tab group `createTab` was asked to place the new tab in (its 2nd argument). */
export function createdTabGroupId(store: LaunchFunnelStore): string | undefined {
  return store.createTab.mock.calls[0]?.[1]
}

/** The launch an AI button's tab queued for its pane's spawn, or undefined when the window planned it. */
export function hostLaunchRequest(store: LaunchFunnelStore): Record<string, unknown> | undefined {
  const options: { pendingStartup?: { agentLaunch?: { launch?: Record<string, unknown> } } } =
    store.createTab.mock.calls[0]?.[3] ?? {}
  return options.pendingStartup?.agentLaunch?.launch
}
