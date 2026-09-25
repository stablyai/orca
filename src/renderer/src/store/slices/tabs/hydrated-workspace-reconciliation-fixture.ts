import type { AppState } from '../../types'
import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import type { OpenFile } from '../editor'

/**
 * Session shape measured on a real heavy profile: 193 workspaces / 382 tabs,
 * spread over every reconciliation outcome (no-op, dropped tab, restored legacy
 * runtime terminal, orphan sweep, editor tab) so a whole-session fold exercises
 * both the workspace-scoped maps and the store-global ones workspaces share.
 */
export const HYDRATED_WORKSPACE_COUNT = 193
export const HYDRATED_TAB_COUNT = 382

const BUCKETS = ['stable', 'stale', 'legacy', 'orphan', 'editor'] as const
type Bucket = (typeof BUCKETS)[number]

export type HydratedWorkspaceFixture = {
  workspaceIds: string[]
  tabCount: number
  state: Partial<AppState>
}

type FixtureDraft = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  tabsByWorktree: Record<string, TerminalTab[]>
  activeTabIdByWorktree: Record<string, string | null>
  tabBarOrderByWorktree: Record<string, string[]>
  ptyIdsByTabId: Record<string, string[]>
  pendingReconnectPtyIdByTabId: Record<string, string>
  unreadTerminalTabs: Record<string, true>
  cacheTimerByKey: Record<string, number>
  openFiles: OpenFile[]
}

function unifiedTab(id: string, worktreeId: string, groupId: string, over: Partial<Tab>): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...over
  }
}

function runtimeTab(id: string, worktreeId: string, over: Partial<TerminalTab>): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...over
  }
}

function setGroup(draft: FixtureDraft, worktreeId: string, groupId: string, tabs: Tab[]): void {
  draft.unifiedTabsByWorktree[worktreeId] = tabs
  draft.groupsByWorktree[worktreeId] = [
    {
      id: groupId,
      worktreeId,
      activeTabId: tabs[0]?.id ?? null,
      tabOrder: tabs.map((tab) => tab.id)
    }
  ]
}

/** Live terminal rows that reconcile to a no-op patch. */
function buildStableWorkspace(draft: FixtureDraft, worktreeId: string, groupId: string): number {
  const live = `${worktreeId}#live`
  setGroup(draft, worktreeId, groupId, [unifiedTab(live, worktreeId, groupId, {})])
  draft.tabsByWorktree[worktreeId] = [runtimeTab(live, worktreeId, {})]
  return 1
}

/** A unified row with no runtime backing: dropped, and its store-global unread flag with it. */
function buildStaleWorkspace(draft: FixtureDraft, worktreeId: string, groupId: string): number {
  const live = `${worktreeId}#live`
  const stale = `${worktreeId}#stale`
  setGroup(draft, worktreeId, groupId, [
    unifiedTab(live, worktreeId, groupId, {}),
    unifiedTab(stale, worktreeId, groupId, { sortOrder: 1 })
  ])
  draft.tabsByWorktree[worktreeId] = [runtimeTab(live, worktreeId, {})]
  draft.unreadTerminalTabs[stale] = true
  return 2
}

/** Live only in a reconnect map: restored into the unified model, minting a group and layout. */
function buildLegacyWorkspace(draft: FixtureDraft, worktreeId: string): number {
  const legacy = `${worktreeId}#legacy`
  draft.tabsByWorktree[worktreeId] = [runtimeTab(legacy, worktreeId, { ptyId: null })]
  draft.pendingReconnectPtyIdByTabId[legacy] = `session-${legacy}`
  draft.ptyIdsByTabId[legacy] = []
  draft.unifiedTabsByWorktree[worktreeId] = []
  draft.groupsByWorktree[worktreeId] = []
  draft.activeTabIdByWorktree[worktreeId] = legacy
  return 1
}

/** No PTY and no unified row: swept, which writes the store-global per-tab maps. */
function buildOrphanWorkspace(draft: FixtureDraft, worktreeId: string): number {
  const orphan = `${worktreeId}#orphan`
  draft.tabsByWorktree[worktreeId] = [runtimeTab(orphan, worktreeId, { ptyId: null })]
  draft.tabBarOrderByWorktree[worktreeId] = [orphan]
  draft.activeTabIdByWorktree[worktreeId] = orphan
  draft.cacheTimerByKey[`${orphan}:git`] = 1
  draft.unifiedTabsByWorktree[worktreeId] = []
  draft.groupsByWorktree[worktreeId] = []
  return 1
}

/** One editor tab backed by an open file, one that is not — the openFiles rescan path. */
function buildEditorWorkspace(draft: FixtureDraft, worktreeId: string, groupId: string): number {
  const fileId = `${worktreeId}#file`
  const ghost = `${worktreeId}#ghost-file`
  setGroup(draft, worktreeId, groupId, [
    unifiedTab(fileId, worktreeId, groupId, { contentType: 'editor' }),
    unifiedTab(ghost, worktreeId, groupId, { contentType: 'editor', sortOrder: 1 })
  ])
  draft.tabsByWorktree[worktreeId] = []
  draft.openFiles.push({
    id: fileId,
    filePath: `/tmp/${worktreeId}/${fileId}`,
    relativePath: fileId,
    worktreeId,
    language: 'typescript',
    isDirty: false,
    mode: 'edit'
  })
  return 2
}

function buildWorkspace(
  draft: FixtureDraft,
  bucket: Bucket,
  worktreeId: string,
  groupId: string
): number {
  switch (bucket) {
    case 'stable':
      return buildStableWorkspace(draft, worktreeId, groupId)
    case 'stale':
      return buildStaleWorkspace(draft, worktreeId, groupId)
    case 'legacy':
      return buildLegacyWorkspace(draft, worktreeId)
    case 'orphan':
      return buildOrphanWorkspace(draft, worktreeId)
    case 'editor':
      return buildEditorWorkspace(draft, worktreeId, groupId)
  }
}

/** Tops the fixture up to the measured tab count with extra live rows. */
function padToTabCount(draft: FixtureDraft, workspaceIds: string[], missing: number): number {
  let added = 0
  for (let slot = 0; added < missing; slot += 1) {
    const worktreeId = workspaceIds[slot % workspaceIds.length]
    const group = draft.groupsByWorktree[worktreeId]?.[0]
    if (!group || draft.tabsByWorktree[worktreeId] == null) {
      continue
    }
    const id = `${worktreeId}#extra-${slot}`
    draft.unifiedTabsByWorktree[worktreeId].push(
      unifiedTab(id, worktreeId, group.id, { sortOrder: 10 + slot })
    )
    draft.tabsByWorktree[worktreeId].push(runtimeTab(id, worktreeId, { sortOrder: 10 + slot }))
    group.tabOrder.push(id)
    added += 1
  }
  return added
}

export function buildHydratedWorkspaceFixture(
  workspaceCount = HYDRATED_WORKSPACE_COUNT,
  tabCountTarget = HYDRATED_TAB_COUNT
): HydratedWorkspaceFixture {
  const draft: FixtureDraft = {
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    tabsByWorktree: {},
    activeTabIdByWorktree: {},
    tabBarOrderByWorktree: {},
    ptyIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {},
    unreadTerminalTabs: {},
    cacheTimerByKey: {},
    openFiles: []
  }
  const workspaceIds: string[] = []
  let tabCount = 0

  for (let index = 0; index < workspaceCount; index += 1) {
    const worktreeId = `repo1::/tmp/w${index}`
    const groupId = `g-${index}`
    workspaceIds.push(worktreeId)
    draft.activeGroupIdByWorktree[worktreeId] = groupId
    tabCount += buildWorkspace(draft, BUCKETS[index % BUCKETS.length], worktreeId, groupId)
  }
  tabCount += padToTabCount(draft, workspaceIds, Math.max(0, tabCountTarget - tabCount))

  return { workspaceIds, tabCount, state: { ...draft } }
}

/** Every top-level key the two reconciliation patch producers can write. */
export const RECONCILIATION_WRITABLE_KEYS = [
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'activeGroupIdByWorktree',
  'layoutByWorktree',
  'unreadTerminalTabs',
  'tabsByWorktree',
  'ptyIdsByTabId',
  'runtimePaneTitlesByTabId',
  'expandedPaneByTabId',
  'canExpandPaneByTabId',
  'terminalLayoutsByTabId',
  'pendingStartupByTabId',
  'pendingInitialCwdByTabId',
  'pendingSetupSplitByTabId',
  'pendingIssueCommandSplitByTabId',
  'automaticAgentResumeClaimsByTabId',
  'nativeChatLaunchPromptByTabId',
  'nativeChatLaunchDraftByTabId',
  'tabBarOrderByWorktree',
  'cacheTimerByKey',
  'activeTabIdByWorktree',
  'activeTabId'
] as const satisfies readonly (keyof AppState)[]
