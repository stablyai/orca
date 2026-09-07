import { vi } from 'vitest'
import type { WindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'

/**
 * Shared rig for the tab-strip worktree-write gate tests. The platform check in
 * `use-tab-bar-runtime-model` is read once at module load, so each platform needs
 * its own test file; everything but the `vi.mock` calls lives here.
 */
export type TabBarProbeState = {
  settings: Record<string, unknown> | null
  persistedUIReady: boolean
  mobileEmulatorTabIntroDismissed: boolean
  gitStatusByWorktree: Record<string, never[]>
  unifiedTabsByWorktree: Record<string, never[]>
  activeGroupIdByWorktree: Record<string, string>
  activeRepoId: string | null
  activeWorktreeId: string | null
  projects: unknown[]
  repos: unknown[]
  worktreesByRepo: Record<string, unknown[]>
  sshConnectionStates: Map<string, unknown>
  pinTab: (tabId: string) => void
  unpinTab: (tabId: string) => void
  toggleTabViewMode: (tabId: string) => void
}

export type TabBarProbeStore = {
  (selector: (state: TabBarProbeState) => unknown): unknown
  getState: () => TabBarProbeState
  setState: (partial: Partial<TabBarProbeState>) => void
}

const noop = (): void => {}

// Both specifiers resolve to the same store module; memoize so they share one instance.
export async function createTabBarProbeStore(): Promise<TabBarProbeStore> {
  const globalKey = '__tabBarRuntimeModelProbeStore'
  const globals = globalThis as Record<string, unknown>
  if (!globals[globalKey]) {
    const { create } = await import('zustand')
    globals[globalKey] = create<TabBarProbeState>(() => ({
      settings: null,
      persistedUIReady: true,
      mobileEmulatorTabIntroDismissed: true,
      gitStatusByWorktree: {},
      unifiedTabsByWorktree: {},
      activeGroupIdByWorktree: {},
      activeRepoId: null,
      activeWorktreeId: null,
      projects: [],
      repos: [],
      worktreesByRepo: {},
      sshConnectionStates: new Map(),
      pinTab: noop,
      unpinTab: noop,
      toggleTabViewMode: noop
    }))
  }
  return globals[globalKey] as TabBarProbeStore
}

/** Mutable so a test can flip the probed host platform without changing identity. */
export const probeWindowsCapabilities: WindowsTerminalCapabilities = {
  wslAvailable: false,
  wslDistros: [],
  pwshAvailable: false,
  gitBashAvailable: false,
  hostPlatform: 'darwin',
  isLoading: false
}

export const localProjectRuntimeSpy = vi.fn(() => undefined)

const AGENT_PROJECTIONS = Object.freeze({
  nativeChatEnabled: false,
  tabAgentTypesByTabId: Object.freeze({}),
  nativeChatTabWideFallbackUnsafeTabsById: Object.freeze({})
})
const CREATION_POLICY = Object.freeze({
  'managed-browser': { state: 'enabled' },
  'mobile-emulator': { state: 'enabled' }
})
const DETECTED_AGENTS = Object.freeze({ detectedIds: Object.freeze([]) })
const RUNTIME_TARGET = Object.freeze({ kind: 'local' })
const CREATE_MENU = Object.freeze({})
const ITEM_PROJECTION = Object.freeze({
  orderedItems: Object.freeze([]),
  activeVisibleTabId: null,
  tabStripLayoutKey: 'probe'
})
const OVERFLOW_NAVIGATION = Object.freeze({
  scrollTabStrip: noop,
  tabStripOverflowState: Object.freeze({ canScrollStart: false, canScrollEnd: false })
})
const DRAG_SCROLL = Object.freeze({
  isTabDragActive: false,
  onDragScrollStartEnter: noop,
  onDragScrollEndEnter: noop,
  onDragScrollLeave: noop
})

export function tabBarRuntimeModelStubs(): Record<string, () => Record<string, unknown>> {
  return {
    shortcutLabels: () => ({
      useShortcutLabel: () => '',
      useOptionalShortcutLabel: () => null
    }),
    detectedAgents: () => ({ useDetectedAgents: () => DETECTED_AGENTS }),
    detectionTarget: () => ({ useAgentDetectionTargetForWorktree: () => null }),
    connectionContext: () => ({ getConnectionIdFromState: () => null }),
    runtimeOwner: () => ({ getRuntimeEnvironmentIdForWorktree: () => null }),
    runtimeRpcClient: () => ({ getActiveRuntimeTarget: () => RUNTIME_TARGET }),
    nativeChatReadability: () => ({ isNativeChatTranscriptLocalReadable: () => false }),
    creationPolicy: () => ({ getClientCreationActionPolicy: () => CREATION_POLICY }),
    agentProjections: () => ({ selectTabBarAgentProjections: () => AGENT_PROJECTIONS }),
    localPreflight: () => ({
      getLocalProjectExecutionRuntimeContext: localProjectRuntimeSpy
    }),
    windowsCapabilities: () => ({
      getWindowsTerminalCapabilityOwnerKey: () => 'probe',
      useWindowsTerminalCapabilities: () => probeWindowsCapabilities
    })
  }
}

export const tabBarSurfaceRenders = { count: 0 }

export function tabBarShellStubs(): Record<string, () => Record<string, unknown>> {
  return {
    surface: () => ({
      renderTabBarSurface: () => {
        tabBarSurfaceRenders.count += 1
        return null
      }
    }),
    createMenuController: () => ({ useTabBarCreateMenuController: () => CREATE_MENU }),
    itemProjection: () => ({ useTabBarItemProjection: () => ITEM_PROJECTION }),
    overflowNavigation: () => ({ useTabStripOverflowNavigation: () => OVERFLOW_NAVIGATION }),
    dragScroll: () => ({ useTabStripDragScrollHandlers: () => DRAG_SCROLL }),
    clientHostedBrowserRows: () => ({ useActiveClientHostedBrowserRowId: () => null })
  }
}

export const TAB_BAR_PROBE_PROPS = {
  tabs: [],
  activeTabId: null,
  worktreeId: 'wt-target',
  expandedPaneByTabId: {},
  onActivate: noop,
  onClose: noop,
  onCloseOthers: noop,
  onCloseToRight: noop,
  onCloseToLeft: noop,
  onNewTerminalTab: noop,
  onNewBrowserTab: noop,
  onSetCustomTitle: noop,
  onSetTabColor: noop,
  onTogglePaneExpand: noop
} as const

/** One fresh `worktreesByRepo` identity, exactly as a worktree write publishes it. */
export function pushWorktreeWrite(store: TabBarProbeStore, tick: number): void {
  store.setState({ worktreesByRepo: { 'repo-1': [{ id: `wt-${tick}`, repoId: 'repo-1' }] } })
}
