import { createBrowserUuid } from '@/lib/browser-uuid'
import type { AppState } from '@/store/types'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileTerminalTheme
} from '../../../../shared/runtime-types'
import type {
  AgentStatusProjectionCache,
  BrowserPagesProjectionCache,
  BrowserWorkspacesProjectionCache,
  EditorDraftHashCache,
  MobileSessionWorktreeInputs,
  OpenFileIndexes,
  OpenFilesProjectionCache,
  RegisteredTerminalTab,
  TabsProjectionCache
} from './types'

export const NO_TRANSPORT_GRACE_MS = 10_000
export const AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS = 30_000
export const RUNTIME_GRAPH_SYNC_COALESCE_MS = 16

export const EMPTY_ACTIVE_BROWSER_TAB_ID_BY_WORKTREE: AppState['activeBrowserTabIdByWorktree'] = {}
export const EMPTY_BROWSER_TABS_BY_WORKTREE: AppState['browserTabsByWorktree'] = {}
export const EMPTY_BROWSER_PAGES_BY_WORKSPACE: AppState['browserPagesByWorkspace'] = {}
export const EMPTY_LAYOUT_BY_WORKTREE: AppState['layoutByWorktree'] = {}
export const EMPTY_AGENT_STATUS_BY_PANE_KEY: AppState['agentStatusByPaneKey'] = {}
export const EMPTY_NARROWED_BY_KEY: ReadonlyMap<string, never> = new Map<string, never>()
export const EMPTY_WORKTREE_TERMINAL_TABS: AppState['tabsByWorktree'][string] = []
export const EMPTY_WORKTREE_BROWSER_WORKSPACES: AppState['browserTabsByWorktree'][string] = []
export const EMPTY_WORKTREE_UNIFIED_TABS: AppState['unifiedTabsByWorktree'][string] = []
export const EMPTY_WORKTREE_TAB_GROUPS: AppState['groupsByWorktree'][string] = []
export const EMPTY_WORKTREE_OPEN_FILE_IDS: readonly string[] = []

export const mobilePublicationEpoch = `renderer:${createBrowserUuid()}`

export type RegisteredTerminalTabKey = string

export const graphState = {
  registeredTabs: new Map<RegisteredTerminalTabKey, RegisteredTerminalTab>(),
  tabRegisteredAt: new Map<RegisteredTerminalTabKey, number>(),
  syncScheduled: false,
  syncInFlight: false,
  syncPendingAfterFlight: false,
  syncEnabled: false,
  syncTimer: null as ReturnType<typeof setTimeout> | null,
  getStoreState: null as (() => AppState) | null,
  mobileSessionSnapshotVersion: 0,
  mobileSessionSnapshotCacheByWorktree: new Map<
    string,
    {
      inputs: MobileSessionWorktreeInputs
      content: unknown
      snapshot: RuntimeMobileSessionTabsSnapshot
    }
  >(),
  publishedMobileSessionSnapshotByWorktree: new Map<string, RuntimeMobileSessionTabsSnapshot>(),
  cachedTabsProjection: null as TabsProjectionCache | null,
  cachedAgentStatusProjection: null as AgentStatusProjectionCache | null,
  cachedOpenFilesProjection: null as OpenFilesProjectionCache | null,
  cachedBrowserWorkspacesProjection: null as BrowserWorkspacesProjectionCache | null,
  cachedBrowserPagesProjection: null as BrowserPagesProjectionCache | null,
  cachedOpenFileIndexesSource: null as AppState['openFiles'] | null,
  cachedOpenFileIndexes: null as OpenFileIndexes | null,
  cachedEditorDraftHashes: null as EditorDraftHashCache | null,
  cachedMobileTerminalThemeSettings: null as AppState['settings'] | null,
  cachedMobileTerminalThemeSystemPrefersDark: null as boolean | null,
  cachedMobileTerminalTheme: undefined as RuntimeMobileTerminalTheme | undefined,
  hasCachedMobileTerminalTheme: false
}

export function registeredTerminalTabKey(
  worktreeId: string,
  tabId: string
): RegisteredTerminalTabKey {
  return `${worktreeId}\0${tabId}`
}

export function findRegisteredTerminalTab(
  tabId: string,
  worktreeId?: string
): { key: RegisteredTerminalTabKey; tab: RegisteredTerminalTab } | null {
  if (worktreeId !== undefined) {
    const key = registeredTerminalTabKey(worktreeId, tabId)
    const tab = graphState.registeredTabs.get(key)
    return tab ? { key, tab } : null
  }

  let match: { key: RegisteredTerminalTabKey; tab: RegisteredTerminalTab } | null = null
  for (const [key, tab] of graphState.registeredTabs) {
    if (tab.tabId !== tabId) {
      continue
    }
    // A tab id without its worktree is ambiguous; callers must fail closed.
    if (match) {
      return null
    }
    match = { key, tab }
  }
  return match
}

/** IDs occurring more than once cannot address the legacy tab-keyed runtime maps safely. */
export function collectAmbiguousTerminalTabIds(
  tabsByWorktree: AppState['tabsByWorktree']
): ReadonlySet<string> {
  const seen = new Set<string>()
  const ambiguous = new Set<string>()
  for (const tabs of Object.values(tabsByWorktree)) {
    for (const tab of tabs) {
      if (seen.has(tab.id)) {
        ambiguous.add(tab.id)
      } else {
        seen.add(tab.id)
      }
    }
  }
  return ambiguous
}

// Structural equality under JSON-serialization semantics (undefined-valued keys are absent).
export function jsonContentEquals(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false
    }
    return a.every((item, index) => jsonContentEquals(item, b[index]))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  for (const key of Object.keys(aRecord)) {
    if (!jsonContentEquals(aRecord[key], bRecord[key])) {
      return false
    }
  }
  for (const key of Object.keys(bRecord)) {
    if (bRecord[key] !== undefined && aRecord[key] === undefined) {
      return false
    }
  }
  return true
}

export type MobileSessionContent = {
  activeGroupId: string | null
  activeTabId: string | null
  activeTabType: RuntimeMobileSessionSnapshotTab['type'] | null
  tabGroups?: NonNullable<RuntimeMobileSessionTabsSnapshot['tabGroups']>
  tabGroupLayout?: RuntimeMobileSessionTabsSnapshot['tabGroupLayout']
  tabs: RuntimeMobileSessionSnapshotTab[]
}
