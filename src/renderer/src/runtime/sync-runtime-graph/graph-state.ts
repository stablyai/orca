import { createBrowserUuid } from '@/lib/browser-uuid'
import type { AppState } from '@/store/types'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileTerminalTheme
} from '../../../../shared/runtime-types'
import type {
  AgentStatusProjectionCache,
  TerminalTabOwnershipIndex,
  BrowserPagesProjectionCache,
  BrowserWorkspacesProjectionCache,
  EditorDraftHashCache,
  MobileSessionAgentStatusCache,
  MobileSessionWorktreeInputs,
  MobileSessionWorktreeSourceRefs,
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
  /** Derived from `registeredTabs`; lets the publication loops reject an unmounted tab without building its key. */
  registeredTabIdsByWorktree: new Map<string, Set<string>>(),
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
      sourceRefs: MobileSessionWorktreeSourceRefs
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

// Module-local rather than `graphState` fields: a nullable field on that object literal needs an
// `as` cast, which the changed-code casting gate rejects.
let terminalTabOwnershipIndexCache: TerminalTabOwnershipIndex | null = null
let mobileSessionAgentStatusCache: MobileSessionAgentStatusCache | null = null

export function getMobileSessionAgentStatusCache(): MobileSessionAgentStatusCache | null {
  return mobileSessionAgentStatusCache
}

export function setMobileSessionAgentStatusCache(cache: MobileSessionAgentStatusCache): void {
  mobileSessionAgentStatusCache = cache
}

export function resetRuntimeGraphSliceScanCaches(): void {
  terminalTabOwnershipIndexCache = null
  mobileSessionAgentStatusCache = null
}

export function registeredTerminalTabKey(
  worktreeId: string,
  tabId: string
): RegisteredTerminalTabKey {
  return `${worktreeId}\0${tabId}`
}

/** Both registration maps move together; callers must never touch `registeredTabs` directly. */
export function addRegisteredTerminalTab(tab: RegisteredTerminalTab): RegisteredTerminalTabKey {
  const key = registeredTerminalTabKey(tab.worktreeId, tab.tabId)
  graphState.registeredTabs.set(key, tab)
  graphState.tabRegisteredAt.set(key, Date.now())
  let tabIds = graphState.registeredTabIdsByWorktree.get(tab.worktreeId)
  if (!tabIds) {
    tabIds = new Set()
    graphState.registeredTabIdsByWorktree.set(tab.worktreeId, tabIds)
  }
  tabIds.add(tab.tabId)
  return key
}

export function removeRegisteredTerminalTab(tab: RegisteredTerminalTab): void {
  const key = registeredTerminalTabKey(tab.worktreeId, tab.tabId)
  graphState.registeredTabs.delete(key)
  graphState.tabRegisteredAt.delete(key)
  const tabIds = graphState.registeredTabIdsByWorktree.get(tab.worktreeId)
  if (!tabIds) {
    return
  }
  tabIds.delete(tab.tabId)
  // Drop the empty bucket so a long-lived session does not retain one Set per visited worktree.
  if (tabIds.size === 0) {
    graphState.registeredTabIdsByWorktree.delete(tab.worktreeId)
  }
}

export function findRegisteredTerminalTab(
  tabId: string,
  worktreeId?: string
): { key: RegisteredTerminalTabKey; tab: RegisteredTerminalTab } | null {
  if (worktreeId !== undefined) {
    // The publication loops ask this for every persisted tab, but only mounted panes register.
    // Rejecting on the index first keeps the common miss free of key-string allocation.
    if (!graphState.registeredTabIdsByWorktree.get(worktreeId)?.has(tabId)) {
      return null
    }
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

/**
 * Which worktree owns each unambiguously-owned terminal tab, plus the ids that no worktree owns.
 *
 * IDs occurring more than once cannot address the legacy tab-keyed runtime maps safely, so they
 * appear in neither map. Memoized on slice identity: every publication scanned all tabs in all
 * worktrees, but `tabsByWorktree` is copy-on-write, so an unchanged reference cannot hide a new
 * duplicate.
 */
export function getTerminalTabOwnershipIndex(
  tabsByWorktree: AppState['tabsByWorktree']
): TerminalTabOwnershipIndex {
  const cached = terminalTabOwnershipIndexCache
  if (cached?.source === tabsByWorktree) {
    return cached
  }
  const worktreeIdByTabId = new Map<string, string>()
  const tabById = new Map<string, AppState['tabsByWorktree'][string][number]>()
  const ambiguousTabIds = new Set<string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      if (worktreeIdByTabId.has(tab.id) || ambiguousTabIds.has(tab.id)) {
        worktreeIdByTabId.delete(tab.id)
        tabById.delete(tab.id)
        ambiguousTabIds.add(tab.id)
        continue
      }
      worktreeIdByTabId.set(tab.id, worktreeId)
      tabById.set(tab.id, tab)
    }
  }
  const previousAmbiguous = cached?.ambiguousTabIds
  const index: TerminalTabOwnershipIndex = {
    source: tabsByWorktree,
    worktreeIdByTabId,
    tabById,
    // Why reuse the set object: one OSC title frame replaces `tabsByWorktree`, and a fresh set here
    // would make every worktree's source fingerprint differ even though ownership did not move.
    ambiguousTabIds: sameMembers(previousAmbiguous, ambiguousTabIds)
      ? previousAmbiguous
      : ambiguousTabIds
  }
  terminalTabOwnershipIndexCache = index
  return index
}

function sameMembers(
  previous: ReadonlySet<string> | undefined,
  next: ReadonlySet<string>
): previous is ReadonlySet<string> {
  if (previous === undefined || previous.size !== next.size) {
    return false
  }
  for (const member of next) {
    if (!previous.has(member)) {
      return false
    }
  }
  return true
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
