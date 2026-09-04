import { findIndexedRepoOwnerForHost } from '@/lib/worktree-runtime-owner-index'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  effectiveWorktreeAgentRowStartedAt,
  tabFromWorktreeAttributedStatusEntry
} from '../sidebar/worktree-agent-row-fallback-tab'
import type { BuildActivityEventsArgs } from './activity-event-builder'
import { standaloneActivityWorktree } from './activity-standalone-worktree'

export type ActivityTabContext = { worktreeId: string; tab: TerminalTab }
export type ActivityEventOwner = { worktree: Worktree; repo: Repo | null; knownWorktree: boolean }
export type ActivityTabHostIndex = Map<string, Map<string, ExecutionHostId | null>>

// Why memoized on the source object: the pane build cache compares `tab` by identity, so a
// fresh derived object per rebuild would miss the cache for every agent-session and
// missing-tab row. Upstream keeps the source identity stable while its fields are unchanged.
const agentSessionTerminalTabs = new WeakMap<Tab, TerminalTab>()
const attributedTabContexts = new WeakMap<AgentStatusEntry, ActivityTabContext | null>()

function terminalTabFromAgentSessionTab(tab: Tab): TerminalTab {
  const cached = agentSessionTerminalTabs.get(tab)
  if (cached) {
    return cached
  }
  const derived: TerminalTab = {
    id: tab.id,
    ptyId: null,
    worktreeId: tab.worktreeId,
    title: tab.customLabel ?? tab.generatedLabel ?? tab.label,
    customTitle: tab.customLabel,
    color: tab.color,
    isPinned: tab.isPinned,
    sortOrder: tab.sortOrder,
    createdAt: tab.createdAt
  }
  agentSessionTerminalTabs.set(tab, derived)
  return derived
}

export function buildActivityTabContext(
  tabsByWorktree: Record<string, TerminalTab[]>,
  unifiedTabsByWorktree?: Record<string, Tab[]>
): Map<string, ActivityTabContext> {
  const contexts = new Map<string, ActivityTabContext>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      contexts.set(tab.id, { worktreeId, tab })
    }
  }
  for (const [worktreeId, tabs] of Object.entries(unifiedTabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (tab.contentType !== 'agent-session' || contexts.has(tab.id)) {
        continue
      }
      contexts.set(tab.id, { worktreeId, tab: terminalTabFromAgentSessionTab(tab) })
    }
  }
  return contexts
}

export function attributedActivityTabContext(entry: AgentStatusEntry): ActivityTabContext | null {
  const cached = attributedTabContexts.get(entry)
  if (cached !== undefined) {
    return cached
  }
  const tab = tabFromWorktreeAttributedStatusEntry(entry, effectiveWorktreeAgentRowStartedAt(entry))
  const context = tab ? { worktreeId: tab.worktreeId, tab } : null
  attributedTabContexts.set(entry, context)
  return context
}

export function buildActivityTabHostIndex(
  unifiedTabsByWorktree?: Record<string, Tab[]>
): ActivityTabHostIndex {
  const index: ActivityTabHostIndex = new Map()
  for (const [worktreeId, tabs] of Object.entries(unifiedTabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (
        (tab.contentType !== 'terminal' && tab.contentType !== 'agent-session') ||
        !tab.executionHostId
      ) {
        continue
      }
      let byTabId = index.get(worktreeId)
      if (!byTabId) {
        byTabId = new Map()
        index.set(worktreeId, byTabId)
      }
      const contextTabId = tab.contentType === 'terminal' ? tab.entityId : tab.id
      const existing = byTabId.get(contextTabId)
      byTabId.set(
        contextTabId,
        existing === undefined || existing === tab.executionHostId ? tab.executionHostId : null
      )
    }
  }
  return index
}

function resolveActivityExecutionHostId(
  context: ActivityTabContext,
  entry: AgentStatusEntry,
  terminalPtyId: string | null | undefined,
  tabHostIndex: ActivityTabHostIndex
): ExecutionHostId | undefined {
  const tabHostId = tabHostIndex.get(context.worktreeId)?.get(context.tab.id)
  if (tabHostId) {
    return tabHostId
  }
  // Why before connectionId: a runtime pane's status entry publishes connectionId: null,
  // which would otherwise resolve to LOCAL (see dashboard-card-terminal-input's precedent).
  const runtimeEnvironmentId = getRemoteRuntimePtyEnvironmentId(terminalPtyId ?? '')
  if (runtimeEnvironmentId) {
    return toRuntimeExecutionHostId(runtimeEnvironmentId)
  }
  if (entry.connectionId !== undefined) {
    return entry.connectionId ? toSshExecutionHostId(entry.connectionId) : LOCAL_EXECUTION_HOST_ID
  }
  const connectionId = parseAppSshPtyId(terminalPtyId ?? '')?.connectionId
  return connectionId ? toSshExecutionHostId(connectionId) : undefined
}

export function resolveActivityEventOwner(
  args: BuildActivityEventsArgs,
  context: ActivityTabContext,
  entry: AgentStatusEntry,
  terminalPtyId: string | null | undefined,
  tabHostIndex: ActivityTabHostIndex,
  ownerCache: Map<string, ActivityEventOwner>
): ActivityEventOwner {
  const executionHostId = resolveActivityExecutionHostId(
    context,
    entry,
    terminalPtyId,
    tabHostIndex
  )
  // Why: resolution runs per pane per rebuild and the miss path scans detected worktrees;
  // everything below depends only on worktreeId + host, so memoize per build.
  const ownerCacheKey = `${context.worktreeId}\0${executionHostId ?? ''}`
  const cached = ownerCache.get(ownerCacheKey)
  if (cached) {
    return cached
  }
  const resolvedWorktree = args.resolveWorktree?.(context.worktreeId, executionHostId)
  const mappedWorktree = args.worktreeMap.get(context.worktreeId)
  const worktree =
    resolvedWorktree ??
    mappedWorktree ??
    standaloneActivityWorktree(context.worktreeId, executionHostId)
  let repo =
    executionHostId && args.repos
      ? findIndexedRepoOwnerForHost(args.repos, worktree.repoId, executionHostId)
      : null
  if (!repo && worktree.runtimeOwnerEnvironmentId && args.repos) {
    repo = findIndexedRepoOwnerForHost(
      args.repos,
      worktree.repoId,
      toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId)
    )
  }
  const owner: ActivityEventOwner = {
    worktree,
    repo: repo ?? args.repoMap.get(worktree.repoId) ?? null,
    knownWorktree: Boolean(
      resolvedWorktree || mappedWorktree || args.tabsByWorktree[context.worktreeId]
    )
  }
  ownerCache.set(ownerCacheKey, owner)
  return owner
}
