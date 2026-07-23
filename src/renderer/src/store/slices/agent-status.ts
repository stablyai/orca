/* eslint-disable max-lines -- Why: the agent-status slice co-locates live map, retained snapshots, retention-suppression, and tab-prefix sweep so the teardown contract stays readable end-to-end. Splitting across files would scatter the drop/remove/retain interactions that must stay in lockstep. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  AGENT_STATE_HISTORY_MAX,
  agentSubagentsEqual,
  type AgentStateHistoryEntry,
  type AgentStatusEntry,
  type AgentStatusOrchestrationContext,
  type AgentType,
  type MigrationUnsupportedPtyEntry,
  type ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from '../../../../shared/agent-status-identity'
import { isCommandCodeNewTurnWhileWorking } from '../../../../shared/command-code-turn-boundary'
import type { TerminalPaneLayoutNode, TerminalTab } from '../../../../shared/types'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId
} from '../../../../shared/execution-host'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import {
  getAgentRowGeneratedTitleText,
  getOrcaDispatchTaskId,
  isOrcaDispatchPrompt,
  orchestrationLabelsMatchLiveDispatch
} from '@/lib/agent-row-primary-text'
import {
  resolveAgentPaneAuthorityKey,
  retireAgentPaneAuthorityAliases,
  retireAgentPaneAuthorityAliasesByOwnerTab,
  transferAgentPaneAuthorityAlias
} from './agent-pane-authority'
import { createFreshnessScheduler } from './agent-status-freshness-scheduler'

/** Snapshot of a finished/vanished agent status entry, kept so the dashboard and sidebar hover
 *  keep showing the completion until the user clicks the worktree. `worktreeId` is stamped at
 *  retention time so the row's home is known even after its tab/pty is gone. */
export type RetainedAgentEntry = {
  entry: AgentStatusEntry
  worktreeId: string
  /** Snapshot of the tab at retention time; kept full (not just an id) because the tab may be gone from `tabsByWorktree` by render time. */
  tab: TerminalTab
  agentType: AgentType
  startedAt: number
}

export type AgentStatusWorktreeShutdownReason =
  | 'manual-sleep'
  | 'remove-worktree'
  | 'auto-hibernate-completed-agent'

type AllAgentSessionCaptureMode = 'periodic' | 'quit'

type DropAgentStatusByWorktreeOptions = {
  shutdownReason?: AgentStatusWorktreeShutdownReason
  sleepingPaneKeys?: readonly string[] | ReadonlySet<string>
  retainedCompletionEvidence?: readonly RetainedAgentEntry[]
}

type DropHibernatedAgentPaneOptions = {
  retainedCompletionEvidence?: readonly RetainedAgentEntry[]
}

type DropAgentStatusByTabPrefixOptions = {
  worktreeId?: string
}

type AgentLaunchConfigRegistrationMetadata = {
  agentType?: AgentType
  launchToken?: string
  tabId?: string
  leafId?: string
  terminalHandle?: string
  providerSession?: AgentProviderSessionMetadata
}

type AgentLaunchConfigStatusMetadata = {
  paneKey: string
  agentType?: AgentType
  tabId?: string
  terminalHandle?: string
  launchToken?: string
  providerSession?: AgentProviderSessionMetadata
  existingProviderSession?: AgentProviderSessionMetadata
  providerSessionChanged?: boolean
}

type AgentLaunchConfigRegistryEntry = {
  launchConfig: SleepingAgentLaunchConfig
  registeredAt: number
  identity: AgentLaunchConfigRegistrationMetadata
}

export type AgentStatusSlice = {
  /** Explicit agent status entries keyed by `${tabId}:${leafId}`; real-time only, not persisted. */
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  /** Main-synced dispatch metadata for live panes that may only have title-derived status in the renderer. */
  runtimeAgentOrchestrationByPaneKey: Record<string, AgentStatusOrchestrationContext>
  /** PTYs still reporting legacy numeric pane keys but with registry-backed UUID proof; stored separately from normal hook-reported status. */
  migrationUnsupportedByPtyId: Record<string, MigrationUnsupportedPtyEntry>
  /** Monotonic tick that advances when agent-status freshness boundaries pass. */
  agentStatusEpoch: number
  /** SSH connections whose transient rows were cleared and must reject renderer callbacks
   *  until a later reconnect establishes a new connection lifecycle. */
  transientClearedAgentStatusConnectionIds: Record<string, true>
  /** Arm the shared freshness timer after an external mirror writes live rows. */
  scheduleAgentStatusFreshness: () => void

  /** Retained "done" snapshots of agents gone from `agentStatusByPaneKey`, keyed by paneKey so pane re-appearance overwrites; shared by dashboard and sidebar hover. */
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>

  /** Durable agent sessions captured on sleep (not live rows); power the one-click CLI resume on wake. */
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>

  /** Ephemeral launch snapshots keyed by pane; hook payloads lack Orca launch settings, so the renderer supplies them from startup. */
  agentLaunchConfigByPaneKey: Record<string, AgentLaunchConfigRegistryEntry>

  /** Pane keys explicitly torn down, forbidden from re-retention on next disappearance; a one-shot suppressor consumed by the retention sync. */
  retentionSuppressedPaneKeys: Record<string, true>

  /** Terminal tabs explicitly closed this session; used to drop late in-flight IPC statuses and stale main-cache replays. */
  recentlyClosedAgentStatusTabIds: Record<string, true>

  /** Exact pane authorities retired while sibling panes in the tab stay live. */
  recentlyRetiredAgentStatusPaneKeys: Record<string, true>

  retireAgentPaneAuthority: (paneKey: string) => void
  transferAgentPaneAuthority: (args: {
    fromPaneKey: string
    toPaneKey: string
    ptyId?: string | null
  }) => void

  /** Update or insert an agent status entry from a status payload. */
  setAgentStatus: (
    paneKey: string,
    payload: ParsedAgentStatusPayload & {
      orchestration?: AgentStatusOrchestrationContext
      promptInteractionKey?: string
    },
    terminalTitle?: string,
    timing?: { updatedAt?: number; stateStartedAt?: number },
    routing?: {
      tabId?: string
      worktreeId?: string
      terminalHandle?: string
      connectionId?: string | null
    },
    metadata?: {
      providerSession?: AgentProviderSessionMetadata
      launchConfig?: SleepingAgentLaunchConfig
      launchToken?: string
    }
  ) => void

  /** Record resume identity without creating a visible turn-status row. */
  recordAgentProviderSession: (
    paneKey: string,
    agent: ResumableTuiAgent,
    providerSession: AgentProviderSessionMetadata,
    timing?: { updatedAt?: number },
    routing?: { tabId?: string; worktreeId?: string; connectionId?: string | null },
    metadata?: { launchToken?: string }
  ) => void

  registerAgentLaunchConfig: (
    paneKey: string,
    launchConfig: SleepingAgentLaunchConfig,
    metadata?: AgentLaunchConfigRegistrationMetadata
  ) => void
  getAgentLaunchConfigForStatusEntry: (
    entry: AgentStatusEntry
  ) => SleepingAgentLaunchConfig | undefined
  getAgentLaunchConfigForStatusMetadata: (
    metadata: AgentLaunchConfigStatusMetadata
  ) => SleepingAgentLaunchConfig | undefined
  clearAgentLaunchConfig: (paneKey: string) => void

  setRuntimeAgentOrchestrationByPaneKey: (
    entries: Record<string, AgentStatusOrchestrationContext>
  ) => void

  setMigrationUnsupportedPty: (entry: MigrationUnsupportedPtyEntry) => void
  clearMigrationUnsupportedPty: (ptyId: string) => void

  /** Remove a single entry (e.g., when a pane's terminal exits). */
  removeAgentStatus: (paneKey: string) => void

  /** Remove all entries whose paneKey starts with the given prefix (tab close prefix-sweep). */
  removeAgentStatusByTabPrefix: (tabIdPrefix: string) => void

  /** Remove stale live rows while preserving pane launch and resume identity. */
  clearTransientAgentStatuses: (connectionId: string, clearedAt: number) => void

  /** Remove a single entry AND suppress re-retention on its next disappearance (user-initiated teardown: X button, pane close). */
  dropAgentStatus: (paneKey: string) => void

  /** Remove all entries under a tab AND suppress re-retention for each (tab close — no rows may reappear). */
  dropAgentStatusByTabPrefix: (
    tabIdPrefix: string,
    opts?: DropAgentStatusByTabPrefixOptions
  ) => void

  /** Remove one auto-hibernated completed-agent pane while preserving sibling live/retained rows in the same worktree. */
  dropHibernatedAgentStatusPane: (
    worktreeId: string,
    paneKey: string,
    opts?: DropHibernatedAgentPaneOptions
  ) => void

  /** Remove all entries for a worktree AND suppress re-retention for live rows (worktree sleep/remove).
   *  Sweeps live rows by tab prefix and by main-stamped worktree attribution so worker rows that arrive before their tab don't survive. */
  dropAgentStatusByWorktree: (worktreeId: string, opts?: DropAgentStatusByWorktreeOptions) => void

  captureSleepingAgentSessionsByWorktree: (worktreeId: string, paneKeys?: string[]) => void
  /** Capture resumable agent sessions across every worktree for crash recovery or quit; mode sets live/quit precedence. */
  captureAllSleepingAgentSessions: (mode: AllAgentSessionCaptureMode) => void
  clearSleepingAgentSession: (paneKey: string) => void
  clearSleepingAgentSessionsByPaneKey: (paneKeys: readonly string[]) => void
  clearSleepingAgentSessionsByWorktree: (worktreeId: string) => void
  pruneSleepingAgentSessions: (validWorktreeIds: Set<string>) => void

  /** Retain agent snapshots. Accepts an array so simultaneous disappearances produce a single set() with no mid-loop intermediate states. */
  retainAgents: (entries: RetainedAgentEntry[]) => void

  /** Dismiss a retained entry by its paneKey. */
  dismissRetainedAgent: (paneKey: string) => void

  /** Dismiss all retained entries belonging to a worktree. */
  dismissRetainedAgentsByWorktree: (worktreeId: string) => void

  /** Prune retained entries whose worktreeId is not in the given set. */
  pruneRetainedAgents: (validWorktreeIds: Set<string>) => void

  /** Clear one-shot teardown suppressors after the retention sync declines to retain the row. */
  clearRetentionSuppressedPaneKeys: (paneKeys: string[]) => void
}

// Why: retained entries are heavy (~24KB) and grow unbounded on busy worktrees (dominant renderer OOM); cap, evicting oldest completions first.
const MAX_RETAINED_AGENTS = 500

function capRetainedAgents(
  retained: Record<string, RetainedAgentEntry>,
  maxEntries = MAX_RETAINED_AGENTS
): Record<string, RetainedAgentEntry> {
  const keys = Object.keys(retained)
  if (keys.length <= maxEntries) {
    return retained
  }
  const capped: Record<string, RetainedAgentEntry> = {}
  for (const key of keys.slice(keys.length - maxEntries)) {
    capped[key] = retained[key]
  }
  return capped
}

// Why: missed pane teardown can leak heavy live rows in any state and amplify every status-map copy (#9872).
export const MAX_LIVE_AGENT_STATUSES = 500

type PaneLiveness = 'live' | 'dead' | 'unprovable'

// Why: only a rooted tab proves which leaves are mounted; rootless and headless rows may still be live (#2962).
function classifyPaneKeyLiveness(state: AppState): (paneKey: string) => PaneLiveness {
  const rootedLeafKeys = new Set<string>()
  const rootedTabIds = new Set<string>()
  for (const [tabId, layout] of Object.entries(state.terminalLayoutsByTabId)) {
    if (!layout?.root) {
      continue
    }
    rootedTabIds.add(tabId)
    const stack: TerminalPaneLayoutNode[] = [layout.root]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (node.type === 'leaf') {
        rootedLeafKeys.add(`${tabId}:${node.leafId}`)
      } else {
        stack.push(node.first, node.second)
      }
    }
  }
  return (paneKey) => {
    if (rootedLeafKeys.has(paneKey)) {
      return 'live'
    }
    const tabId = getTabIdFromPaneKey(paneKey)
    return tabId !== null && rootedTabIds.has(tabId) ? 'dead' : 'unprovable'
  }
}

// Why: mutate the caller-owned spread so eviction does not allocate another heavy-map copy.
function capLiveAgentStatusesInPlace(
  freshLive: Record<string, AgentStatusEntry>,
  protectedPaneKey: string,
  buildClassifier: () => (paneKey: string) => PaneLiveness,
  now: number,
  maxEntries = MAX_LIVE_AGENT_STATUSES
): string[] {
  const keys = Object.keys(freshLive)
  let overflow = keys.length - maxEntries
  if (overflow <= 0) {
    return []
  }
  const classify = buildClassifier()
  const evictedPaneKeys: string[] = []
  const sweep = (canEvict: (liveness: PaneLiveness, entry: AgentStatusEntry) => boolean): void => {
    for (const key of keys) {
      if (overflow <= 0) {
        break
      }
      if (key === protectedPaneKey || !(key in freshLive)) {
        continue
      }
      const liveness = classify(key)
      if (liveness === 'live' || !canEvict(liveness, freshLive[key])) {
        continue
      }
      delete freshLive[key]
      overflow -= 1
      evictedPaneKeys.push(key)
    }
  }
  // Prefer rows that are provably dead or too stale to represent a live agent.
  sweep(
    (liveness, entry) => liveness === 'dead' || now - entry.updatedAt > AGENT_STATUS_STALE_AFTER_MS
  )
  // Shed fresh unprovable rows only when needed; rooted live panes make this a soft cap.
  if (overflow > 0) {
    sweep(() => true)
  }
  return evictedPaneKeys
}

function paneKeyMatchesAnyTabPrefix(paneKey: string, tabPrefixes: string[]): boolean {
  for (const prefix of tabPrefixes) {
    if (paneKey.startsWith(prefix)) {
      return true
    }
  }
  return false
}

function isAgentCompletionState(state: ParsedAgentStatusPayload['state']): boolean {
  return state === 'done' || state === 'waiting' || state === 'blocked'
}

function getTabIdFromPaneKey(paneKey: string): string | null {
  const separator = paneKey.indexOf(':')
  if (separator <= 0 || separator !== paneKey.lastIndexOf(':')) {
    return null
  }
  return paneKey.slice(0, separator)
}

/** True when auto-title generation would no-op without replace (custom/quick/generated). */
function agentStatusTabAlreadyHasProtectedOrGeneratedTitle(
  state: AppState,
  tabId: string | null,
  worktreeId?: string | null
): boolean {
  if (!tabId) {
    return false
  }
  const ownerTabs = worktreeId ? state.tabsByWorktree[worktreeId] : undefined
  if (ownerTabs) {
    const tab = ownerTabs.find((candidate) => candidate.id === tabId)
    return Boolean(
      tab?.customTitle?.trim() || tab?.quickCommandLabel?.trim() || tab?.generatedTitle?.trim()
    )
  }
  for (const tabs of Object.values(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (!tab) {
      continue
    }
    return Boolean(
      tab.customTitle?.trim() || tab.quickCommandLabel?.trim() || tab.generatedTitle?.trim()
    )
  }
  return false
}

function getLeafIdFromPaneKey(paneKey: string): string | null {
  const separator = paneKey.indexOf(':')
  if (separator <= 0 || separator !== paneKey.lastIndexOf(':')) {
    return null
  }
  const leafId = paneKey.slice(separator + 1)
  return leafId.length > 0 ? leafId : null
}

function findCompletedOrphanPaneKeysForTabClose(
  state: AppState,
  worktreeId: string | undefined,
  prefix: string
): string[] {
  if (!worktreeId) {
    return []
  }
  const openTabIds = new Set((state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id))
  const paneKeys: string[] = []
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    if (paneKey.startsWith(prefix) || entry.state !== 'done' || entry.worktreeId !== worktreeId) {
      continue
    }
    const tabId = getTabIdFromPaneKey(paneKey)
    if (!tabId || openTabIds.has(tabId)) {
      continue
    }
    paneKeys.push(paneKey)
  }
  return paneKeys
}

function isRecentlyClosedAgentStatusTab(
  closedTabs: Record<string, true>,
  tabId: string | null
): boolean {
  if (!tabId) {
    return false
  }
  return closedTabs[tabId] === true
}

function findAgentPaneWorktreeId(state: AppState, paneKey: string): string | null {
  const tabId = getTabIdFromPaneKey(paneKey)
  if (!tabId) {
    return null
  }
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      return worktreeId
    }
  }
  return null
}

function findTabForAgentEntry(
  state: AppState,
  worktreeId: string,
  entry: AgentStatusEntry
): TerminalTab | undefined {
  const tabId = entry.tabId ?? getTabIdFromPaneKey(entry.paneKey)
  if (!tabId) {
    return undefined
  }
  return (state.tabsByWorktree[worktreeId] ?? []).find((tab) => tab.id === tabId)
}

function getRetainedFallbackTab(entry: AgentStatusEntry, worktreeId: string): TerminalTab {
  const tabId = entry.tabId ?? getTabIdFromPaneKey(entry.paneKey) ?? entry.paneKey
  return {
    id: tabId,
    ptyId: null,
    worktreeId,
    title: entry.terminalTitle ?? 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: entry.stateStartedAt
  }
}

function retainedAgentEntryFromLive(
  state: AppState,
  worktreeId: string,
  entry: AgentStatusEntry,
  agentType: AgentType
): RetainedAgentEntry {
  const tab =
    findTabForAgentEntry(state, worktreeId, entry) ?? getRetainedFallbackTab(entry, worktreeId)
  return {
    entry,
    worktreeId,
    tab,
    agentType,
    startedAt: entry.stateHistory[0]?.startedAt ?? entry.stateStartedAt
  }
}

function shouldReplaceRetainedWithLive(
  retained: RetainedAgentEntry | undefined,
  live: RetainedAgentEntry
): boolean {
  if (!retained) {
    return true
  }
  if (live.startedAt !== retained.startedAt) {
    return live.startedAt > retained.startedAt
  }
  const retainedSessionId = retained.entry.providerSession?.id
  const liveSessionId = live.entry.providerSession?.id
  if (retainedSessionId && liveSessionId && retainedSessionId !== liveSessionId) {
    return live.entry.updatedAt >= retained.entry.updatedAt
  }
  return live.entry.updatedAt > retained.entry.updatedAt
}

function normalizePaneKeySet(
  paneKeys: DropAgentStatusByWorktreeOptions['sleepingPaneKeys']
): ReadonlySet<string> | null {
  if (!paneKeys) {
    return null
  }
  return paneKeys instanceof Set ? paneKeys : new Set(paneKeys)
}

function sleepingRecordFromEntry(args: {
  state: AppState
  entry: AgentStatusEntry
  worktreeId: string
  tab?: TerminalTab
  capturedAt: number
  launchConfig?: SleepingAgentLaunchConfig
  origin?: SleepingAgentSessionRecord['origin']
}): SleepingAgentSessionRecord | null {
  const agent = args.entry.agentType
  if (!isResumableTuiAgent(agent) || !args.entry.providerSession) {
    return null
  }
  if (!getAgentResumeArgv(agent, args.entry.providerSession)) {
    return null
  }
  const tab = args.tab ?? findTabForAgentEntry(args.state, args.worktreeId, args.entry)
  return {
    paneKey: args.entry.paneKey,
    ...(tab ? { tabId: tab.id } : {}),
    worktreeId: args.worktreeId,
    agent,
    providerSession: args.entry.providerSession,
    prompt: args.entry.prompt,
    state: args.entry.state,
    capturedAt: args.capturedAt,
    updatedAt: args.entry.updatedAt,
    ...((args.entry.terminalTitle ?? tab?.title)
      ? { terminalTitle: (args.entry.terminalTitle ?? tab?.title)! }
      : {}),
    ...(args.entry.lastAssistantMessage
      ? { lastAssistantMessage: args.entry.lastAssistantMessage }
      : {}),
    ...(args.launchConfig ? { launchConfig: copyLaunchConfig(args.launchConfig) } : {}),
    ...(args.entry.interrupted ? { interrupted: true } : {}),
    ...(args.origin ? { origin: args.origin } : {})
  }
}

type CollectSleepingAgentSessionRecordsOptions = {
  paneKeys?: readonly string[]
  captureMode?: 'manual-worktree-sleep' | 'completed-agent-hibernation'
}

function normalizeSleepingAgentSessionCollectOptions(
  options: readonly string[] | CollectSleepingAgentSessionRecordsOptions | undefined
): CollectSleepingAgentSessionRecordsOptions {
  if (!options) {
    return {}
  }
  return Array.isArray(options)
    ? { paneKeys: options }
    : (options as CollectSleepingAgentSessionRecordsOptions)
}

function isValidManualSleepLiveAgentEntry(
  state: AppState,
  entry: AgentStatusEntry,
  capturedAt: number
): boolean {
  if (entry.interrupted === true || entry.state === 'done') {
    return false
  }
  const lastInputAt = state.lastTerminalInputAtByPaneKey[entry.paneKey]
  if (
    typeof lastInputAt === 'number' &&
    Number.isFinite(lastInputAt) &&
    lastInputAt > entry.updatedAt
  ) {
    return false
  }
  return isExplicitAgentStatusFresh(entry, capturedAt, AGENT_STATUS_STALE_AFTER_MS)
}

function isValidCompletedAgentHibernationEntry(entry: AgentStatusEntry): boolean {
  return entry.state === 'done' && entry.interrupted !== true
}

function isCompletedPiWithLiveRecoveryRecord(
  entry: AgentStatusEntry | undefined,
  record: SleepingAgentSessionRecord | undefined
): record is SleepingAgentSessionRecord {
  return Boolean(
    entry?.state === 'done' &&
    entry.agentType === 'pi' &&
    entry.providerSession &&
    record?.agent === 'pi' &&
    record.origin === 'live' &&
    (!entry.worktreeId || entry.worktreeId === record.worktreeId) &&
    agentProviderSessionsEqual('pi', entry.providerSession, record.providerSession) &&
    getAgentResumeArgv('pi', record.providerSession)
  )
}

export function removeSleepingRecordsReplacedByManualWorktreeSleep(
  records: Record<string, SleepingAgentSessionRecord>,
  worktreeId: string,
  paneKeys?: readonly string[]
): { records: Record<string, SleepingAgentSessionRecord>; changed: boolean } {
  const allowedPaneKeys = paneKeys ? new Set(paneKeys) : null
  let next = records
  let changed = false
  for (const [paneKey, record] of Object.entries(records)) {
    if (record.worktreeId !== worktreeId || (allowedPaneKeys && !allowedPaneKeys.has(paneKey))) {
      continue
    }
    if (next === records) {
      next = { ...records }
    }
    delete next[paneKey]
    changed = true
  }
  return { records: next, changed }
}

export function collectSleepingAgentSessionRecordsForWorktree(
  state: AppState,
  worktreeId: string,
  options?: readonly string[] | CollectSleepingAgentSessionRecordsOptions
): Record<string, SleepingAgentSessionRecord> {
  const capturedAt = Date.now()
  const collectOptions = normalizeSleepingAgentSessionCollectOptions(options)
  const allowedPaneKeys = collectOptions.paneKeys ? new Set(collectOptions.paneKeys) : null
  const isManualWorktreeSleep = collectOptions.captureMode === 'manual-worktree-sleep'
  const isCompletedAgentHibernation = collectOptions.captureMode === 'completed-agent-hibernation'
  const isWorktreeOwnedCapture = isManualWorktreeSleep || isCompletedAgentHibernation
  // Why: hibernated completions are intentional worktree-owned records; wake treats
  // originless completed records as ambiguous legacy captures.
  const origin: SleepingAgentSessionRecord['origin'] | undefined = isWorktreeOwnedCapture
    ? 'worktree-sleep'
    : undefined
  const tabPrefixes = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
  const records: Record<string, SleepingAgentSessionRecord> = {}

  if (isManualWorktreeSleep) {
    for (const existing of Object.values(state.sleepingAgentSessionsByPaneKey)) {
      const liveEntry = state.agentStatusByPaneKey[existing.paneKey]
      if (
        existing.worktreeId !== worktreeId ||
        existing.origin !== 'live' ||
        (liveEntry !== undefined && !isCompletedPiWithLiveRecoveryRecord(liveEntry, existing)) ||
        (allowedPaneKeys && !allowedPaneKeys.has(existing.paneKey)) ||
        !getAgentResumeArgv(existing.agent, existing.providerSession)
      ) {
        continue
      }
      // Why: Pi identity is resumable with no turn row and while idle after done, so manual
      // sleep must promote both instead of deleting the checkpoint.
      records[existing.paneKey] = {
        ...existing,
        state: 'working',
        capturedAt,
        updatedAt: capturedAt,
        origin: 'worktree-sleep'
      }
    }
  }

  for (const retained of Object.values(state.retainedAgentsByPaneKey)) {
    if (isCompletedAgentHibernation) {
      continue
    }
    if (allowedPaneKeys && !allowedPaneKeys.has(retained.entry.paneKey)) {
      continue
    }
    if (retained.worktreeId !== worktreeId) {
      continue
    }
    const record = sleepingRecordFromEntry({
      state,
      entry: retained.entry,
      worktreeId,
      tab: retained.tab,
      capturedAt,
      launchConfig: getLaunchConfigForEntry(state, retained.entry),
      origin
    })
    if (record) {
      records[record.paneKey] = record
    }
  }

  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    if (allowedPaneKeys && !allowedPaneKeys.has(paneKey)) {
      continue
    }
    const belongsToWorktree =
      entry.worktreeId === worktreeId || paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes)
    if (!belongsToWorktree) {
      continue
    }
    if (isManualWorktreeSleep && !isValidManualSleepLiveAgentEntry(state, entry, capturedAt)) {
      continue
    }
    if (isCompletedAgentHibernation && !isValidCompletedAgentHibernationEntry(entry)) {
      continue
    }
    const record = sleepingRecordFromEntry({
      state,
      entry,
      worktreeId,
      capturedAt,
      launchConfig: getLaunchConfigForEntry(state, entry),
      origin
    })
    if (record) {
      records[record.paneKey] = record
    }
  }

  return records
}

export function collectHibernatedCompletionEvidenceForWorktree(
  state: AppState,
  worktreeId: string,
  paneKeys?: readonly string[]
): RetainedAgentEntry[] {
  const allowedPaneKeys = normalizePaneKeySet(paneKeys)
  if (!allowedPaneKeys || allowedPaneKeys.size === 0) {
    return []
  }
  const tabPrefixes = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
  const retained: RetainedAgentEntry[] = []
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    const agentType = entry.agentType
    if (
      !allowedPaneKeys.has(paneKey) ||
      entry.state !== 'done' ||
      agentType === undefined ||
      entry.interrupted === true
    ) {
      continue
    }
    const belongsToWorktree =
      entry.worktreeId === worktreeId || paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes)
    if (!belongsToWorktree) {
      continue
    }
    retained.push(retainedAgentEntryFromLive(state, worktreeId, entry, agentType))
  }
  return retained
}

// Why: comparing all fields except capturedAt lets an unchanged agent skip the store write,
// so periodic idle re-captures never dirty session persistence.
function sleepingRecordsEquivalentIgnoringCaptureTime(
  existing: SleepingAgentSessionRecord | undefined,
  next: SleepingAgentSessionRecord
): boolean {
  if (!existing) {
    return false
  }
  return (
    existing.paneKey === next.paneKey &&
    existing.tabId === next.tabId &&
    existing.worktreeId === next.worktreeId &&
    existing.agent === next.agent &&
    agentProviderSessionsEqual(existing.agent, existing.providerSession, next.providerSession) &&
    existing.prompt === next.prompt &&
    existing.state === next.state &&
    existing.updatedAt === next.updatedAt &&
    existing.terminalTitle === next.terminalTitle &&
    existing.lastAssistantMessage === next.lastAssistantMessage &&
    existing.interrupted === next.interrupted &&
    existing.origin === next.origin &&
    launchConfigsEqual(existing.launchConfig, next.launchConfig)
  )
}

function recoveryRecordMatches(
  existing: SleepingAgentSessionRecord | undefined,
  next: SleepingAgentSessionRecord
): boolean {
  if (!existing) {
    return false
  }
  return (
    existing.origin === next.origin &&
    existing.agent === next.agent &&
    existing.worktreeId === next.worktreeId &&
    existing.tabId === next.tabId &&
    agentProviderSessionsEqual(existing.agent, existing.providerSession, next.providerSession) &&
    launchConfigsEqual(existing.launchConfig, next.launchConfig)
  )
}

function recoveryRecordTargetsSameSession(
  existing: SleepingAgentSessionRecord | undefined,
  next: SleepingAgentSessionRecord
): boolean {
  if (!existing) {
    return false
  }
  return (
    existing.agent === next.agent &&
    existing.worktreeId === next.worktreeId &&
    existing.tabId === next.tabId &&
    agentProviderSessionsEqual(existing.agent, existing.providerSession, next.providerSession)
  )
}

function copyLaunchConfig(config: SleepingAgentLaunchConfig): SleepingAgentLaunchConfig {
  return {
    ...(config.agentCommand ? { agentCommand: config.agentCommand } : {}),
    agentArgs: config.agentArgs,
    agentEnv: { ...config.agentEnv }
  }
}

function launchConfigsEqual(
  a: SleepingAgentLaunchConfig | undefined,
  b: SleepingAgentLaunchConfig | undefined
): boolean {
  if (a === undefined || b === undefined) {
    return a === b
  }
  if (a.agentCommand !== b.agentCommand || a.agentArgs !== b.agentArgs) {
    return false
  }
  const aKeys = Object.keys(a.agentEnv)
  const bKeys = Object.keys(b.agentEnv)
  return aKeys.length === bKeys.length && aKeys.every((key) => a.agentEnv[key] === b.agentEnv[key])
}

function normalizeLaunchConfigRegistrationMetadata(
  paneKey: string,
  metadata: AgentLaunchConfigRegistrationMetadata | undefined
): AgentLaunchConfigRegistrationMetadata {
  return {
    ...(metadata?.agentType ? { agentType: metadata.agentType } : {}),
    ...(metadata?.launchToken ? { launchToken: metadata.launchToken } : {}),
    tabId: metadata?.tabId ?? getTabIdFromPaneKey(paneKey) ?? undefined,
    leafId: metadata?.leafId ?? getLeafIdFromPaneKey(paneKey) ?? undefined,
    ...(metadata?.terminalHandle ? { terminalHandle: metadata.terminalHandle } : {}),
    ...(metadata?.providerSession ? { providerSession: metadata.providerSession } : {})
  }
}

function launchConfigRegistryEntriesEqual(
  a: AgentLaunchConfigRegistryEntry | undefined,
  b: AgentLaunchConfigRegistryEntry
): boolean {
  return (
    a !== undefined &&
    launchConfigsEqual(a.launchConfig, b.launchConfig) &&
    a.identity.agentType === b.identity.agentType &&
    a.identity.launchToken === b.identity.launchToken &&
    a.identity.tabId === b.identity.tabId &&
    a.identity.leafId === b.identity.leafId &&
    a.identity.terminalHandle === b.identity.terminalHandle &&
    agentProviderSessionsEqual(
      a.identity.agentType ?? b.identity.agentType,
      a.identity.providerSession,
      b.identity.providerSession
    )
  )
}

function registryEntryMatchesStatus(args: {
  entry: AgentLaunchConfigRegistryEntry | undefined
  paneKey: string
  agentType: AgentType | undefined
  tabId: string | undefined
  terminalHandle: string | undefined
  launchToken: string | undefined
  providerSession: AgentProviderSessionMetadata | undefined
  existingProviderSession: AgentProviderSessionMetadata | undefined
  providerSessionChanged: boolean
}): boolean {
  const entry = args.entry
  if (!entry || args.providerSessionChanged) {
    return false
  }
  const identity = entry.identity
  if (identity.agentType !== undefined && identity.agentType !== args.agentType) {
    return false
  }
  if (identity.tabId !== undefined && identity.tabId !== args.tabId) {
    return false
  }
  if (identity.leafId !== undefined && identity.leafId !== getLeafIdFromPaneKey(args.paneKey)) {
    return false
  }
  if (
    identity.terminalHandle !== undefined &&
    (args.terminalHandle === undefined || identity.terminalHandle !== args.terminalHandle)
  ) {
    return false
  }
  if (
    identity.launchToken !== undefined &&
    (args.launchToken === undefined || identity.launchToken !== args.launchToken)
  ) {
    // Why: a missing/mismatched launch token is stale proof even if a later manual/mixed Codex run reused the provider session id.
    return false
  }
  if (identity.providerSession !== undefined) {
    return agentProviderSessionsEqual(
      args.agentType,
      identity.providerSession,
      args.providerSession
    )
  }
  if (identity.launchToken !== undefined) {
    return true
  }
  if (identity.terminalHandle !== undefined) {
    return true
  }
  if (args.existingProviderSession && args.providerSession) {
    return agentProviderSessionsEqual(
      args.agentType,
      args.existingProviderSession,
      args.providerSession
    )
  }
  return false
}

function getLaunchConfigForEntry(
  state: AppState,
  entry: AgentStatusEntry
): SleepingAgentLaunchConfig | undefined {
  const registryEntry = state.agentLaunchConfigByPaneKey[entry.paneKey]
  const registryLaunchConfig = registryEntryMatchesStatus({
    entry: registryEntry,
    paneKey: entry.paneKey,
    agentType: entry.agentType,
    tabId: entry.tabId ?? getTabIdFromPaneKey(entry.paneKey) ?? undefined,
    terminalHandle: entry.terminalHandle,
    launchToken: undefined,
    providerSession: entry.providerSession,
    existingProviderSession: entry.providerSession,
    providerSessionChanged: false
  })
    ? registryEntry?.launchConfig
    : undefined
  if (registryLaunchConfig) {
    return registryLaunchConfig
  }
  const sleepingRecord = state.sleepingAgentSessionsByPaneKey[entry.paneKey]
  return sleepingRecord?.launchConfig &&
    sleepingRecord.agent === entry.agentType &&
    entry.providerSession &&
    agentProviderSessionsEqual(
      entry.agentType,
      sleepingRecord.providerSession,
      entry.providerSession
    )
    ? sleepingRecord.launchConfig
    : undefined
}

// Why: renderer twin of main's #7561 FIFO-capped closedAgentStatusTabIds — suppresses late
// events for a just-closed tab, but was add-only and grew unbounded, hence this cap.
export const RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX = 1024
export const RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX = 1024

// delete-then-set for LRU recency, then evict oldest keys past the cap (Record iterates
// insertion order); safe because a status for a tab closed >MAX tabs ago cannot still arrive.
function boundRecentlyClosedAgentStatusTabIds(
  existing: Record<string, true>,
  tabId: string
): Record<string, true> {
  const next: Record<string, true> = {}
  for (const key of Object.keys(existing)) {
    if (key !== tabId) {
      next[key] = true
    }
  }
  next[tabId] = true
  const keys = Object.keys(next)
  if (keys.length > RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX) {
    for (const stale of keys.slice(0, keys.length - RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX)) {
      delete next[stale]
    }
  }
  return next
}

function boundRecentlyRetiredAgentStatusPaneKeys(
  existing: Record<string, true>,
  paneKeys: readonly string[]
): Record<string, true> {
  const additions = new Set(paneKeys)
  const next: Record<string, true> = {}
  for (const key of Object.keys(existing)) {
    if (!additions.has(key)) {
      next[key] = true
    }
  }
  for (const paneKey of additions) {
    next[paneKey] = true
  }
  const keys = Object.keys(next)
  for (const stale of keys.slice(0, -RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX)) {
    delete next[stale]
  }
  return next
}

function movePaneKeyedRecord<T>(
  record: Record<string, T>,
  fromPaneKey: string,
  toPaneKey: string,
  transform: (value: T) => T = (value) => value
): Record<string, T> {
  const value = record[fromPaneKey]
  if (value === undefined || fromPaneKey === toPaneKey) {
    return record
  }
  const next = { ...record }
  delete next[fromPaneKey]
  next[toPaneKey] = transform(value)
  return next
}

function removePaneKeys<T>(
  record: Record<string, T>,
  paneKeys: ReadonlySet<string>
): Record<string, T> {
  const matchingKeys = Object.keys(record).filter((key) => paneKeys.has(key))
  if (matchingKeys.length === 0) {
    return record
  }
  const next = { ...record }
  for (const key of matchingKeys) {
    delete next[key]
  }
  return next
}

function getLaunchConfigForStatusMetadata(
  state: AppState,
  metadata: AgentLaunchConfigStatusMetadata
): SleepingAgentLaunchConfig | undefined {
  const registryEntry = state.agentLaunchConfigByPaneKey[metadata.paneKey]
  return registryEntryMatchesStatus({
    entry: registryEntry,
    paneKey: metadata.paneKey,
    agentType: metadata.agentType,
    tabId: metadata.tabId ?? getTabIdFromPaneKey(metadata.paneKey) ?? undefined,
    terminalHandle: metadata.terminalHandle,
    launchToken: metadata.launchToken,
    providerSession: metadata.providerSession,
    existingProviderSession: metadata.existingProviderSession,
    providerSessionChanged: metadata.providerSessionChanged ?? false
  })
    ? registryEntry?.launchConfig
    : undefined
}

function pruneMigrationUnsupportedEntries(
  entries: Record<string, MigrationUnsupportedPtyEntry>,
  predicate: (entry: MigrationUnsupportedPtyEntry) => boolean
): { next: Record<string, MigrationUnsupportedPtyEntry>; changed: boolean } {
  let changed = false
  const next: Record<string, MigrationUnsupportedPtyEntry> = {}
  for (const [ptyId, entry] of Object.entries(entries)) {
    if (predicate(entry)) {
      changed = true
      continue
    }
    next[ptyId] = entry
  }
  return { next: changed ? next : entries, changed }
}

function orchestrationContextsEqual(
  a: AgentStatusOrchestrationContext,
  b: AgentStatusOrchestrationContext
): boolean {
  return (
    a.taskId === b.taskId &&
    a.dispatchId === b.dispatchId &&
    a.taskTitle === b.taskTitle &&
    a.displayName === b.displayName &&
    a.parentTerminalHandle === b.parentTerminalHandle &&
    a.parentPaneKey === b.parentPaneKey &&
    a.coordinatorHandle === b.coordinatorHandle &&
    a.orchestrationRunId === b.orchestrationRunId
  )
}

function orchestrationMapsEqual(
  a: Record<string, AgentStatusOrchestrationContext>,
  b: Record<string, AgentStatusOrchestrationContext>
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) {
    return false
  }
  return aKeys.every((key) => b[key] !== undefined && orchestrationContextsEqual(a[key]!, b[key]!))
}

function mergeCurrentOrchestrationContext(
  existing: AgentStatusOrchestrationContext | undefined,
  current: AgentStatusOrchestrationContext
): AgentStatusOrchestrationContext {
  if (!existing) {
    return current
  }
  const sameDispatch =
    existing.taskId === current.taskId && existing.dispatchId === current.dispatchId
  if (!sameDispatch) {
    return current
  }
  const merged = { ...existing, ...current }
  return orchestrationContextsEqual(existing, merged) ? existing : merged
}

// Why: relay/daemon teardown drops main's rows, but renderer entries whose connectionId stamp never
// matched (unstamped over SSH) survive and stay "fresh" 30 min (#9030). Resolve each worktree's host
// via the canonical hostId-first precedence and keep only ids UNAMBIGUOUSLY on this connection — a
// worktree id is `${repoId}::${path}` (no host component), so the same project mirrored at the same
// path on two hosts yields one shared id that must not clear another host's live rows.
function collectWorktreeIdsForConnection(state: AppState, connectionId: string): Set<string> {
  const hostIdsOnConnection = new Set(
    state.repos
      .filter((repo) => repo.connectionId === connectionId)
      .map((repo) => getRepoExecutionHostId(repo))
  )
  if (hostIdsOnConnection.size === 0) {
    return new Set()
  }
  const repoById = new Map(state.repos.map((repo) => [repo.id, repo] as const))
  const onConnection = new Set<string>()
  const onOtherHost = new Set<string>()
  for (const [repoId, worktrees] of Object.entries(state.worktreesByRepo)) {
    const repo = repoById.get(repoId)
    for (const worktree of worktrees) {
      const bucket = hostIdsOnConnection.has(getWorktreeExecutionHostId(worktree, repo))
        ? onConnection
        : onOtherHost
      bucket.add(worktree.id)
    }
  }
  // A worktree id that also lives on another host is ambiguous — leave it rather than hide a live row.
  for (const id of onOtherHost) {
    onConnection.delete(id)
  }
  return onConnection
}

export const createAgentStatusSlice: StateCreator<AppState, [], [], AgentStatusSlice> = (
  set,
  get
) => {
  // Why: scheduler is process-lifetime-scoped (no dispose) because the store is a
  // module-level singleton with no teardown lifecycle anywhere in the codebase.
  const freshness = createFreshnessScheduler({
    getEntries: () => Object.values(get().agentStatusByPaneKey),
    bumpEpochs: () => {
      // Why: freshness is time-based — bump both epochs at the stale boundary to force selector
      // recompute and re-sort even with no new output, since staleness can change worktree ordering.
      set((s) => ({
        agentStatusEpoch: s.agentStatusEpoch + 1,
        sortEpoch: s.sortEpoch + 1
      }))
    }
  })

  const clearSleepingAgentSessionsByPaneKey = (paneKeys: readonly string[]): void => {
    if (paneKeys.length === 0) {
      return
    }
    const uniquePaneKeys = new Set(paneKeys)
    set((s) => {
      let nextSleeping = s.sleepingAgentSessionsByPaneKey
      let nextLaunchConfigs = s.agentLaunchConfigByPaneKey
      for (const paneKey of uniquePaneKeys) {
        if (paneKey in nextSleeping) {
          if (nextSleeping === s.sleepingAgentSessionsByPaneKey) {
            nextSleeping = { ...nextSleeping }
          }
          delete nextSleeping[paneKey]
        }
        if (paneKey in nextLaunchConfigs) {
          if (nextLaunchConfigs === s.agentLaunchConfigByPaneKey) {
            nextLaunchConfigs = { ...nextLaunchConfigs }
          }
          delete nextLaunchConfigs[paneKey]
        }
      }
      if (
        nextSleeping === s.sleepingAgentSessionsByPaneKey &&
        nextLaunchConfigs === s.agentLaunchConfigByPaneKey
      ) {
        return s
      }
      return {
        sleepingAgentSessionsByPaneKey: nextSleeping,
        agentLaunchConfigByPaneKey: nextLaunchConfigs
      }
    })
  }

  return {
    agentStatusByPaneKey: {},
    runtimeAgentOrchestrationByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    agentStatusEpoch: 0,
    transientClearedAgentStatusConnectionIds: {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    retentionSuppressedPaneKeys: {},
    recentlyClosedAgentStatusTabIds: {},
    recentlyRetiredAgentStatusPaneKeys: {},
    scheduleAgentStatusFreshness: () => freshness.schedule(),

    retireAgentPaneAuthority: (paneKey) => {
      const ownerPaneKey = resolveAgentPaneAuthorityKey(paneKey)
      const retiredPaneKeys = retireAgentPaneAuthorityAliases(paneKey)
      const retiredPaneKeySet = new Set(retiredPaneKeys)
      let hadLive = false
      set((s) => {
        const retiredLivePaneKeys = retiredPaneKeys.filter((key) => key in s.agentStatusByPaneKey)
        hadLive = retiredLivePaneKeys.length > 0
        let nextRetentionSuppressedPaneKeys = removePaneKeys(
          s.retentionSuppressedPaneKeys,
          retiredPaneKeySet
        )
        if (
          retiredLivePaneKeys.length > 0 &&
          nextRetentionSuppressedPaneKeys === s.retentionSuppressedPaneKeys
        ) {
          nextRetentionSuppressedPaneKeys = { ...nextRetentionSuppressedPaneKeys }
        }
        for (const key of retiredLivePaneKeys) {
          nextRetentionSuppressedPaneKeys[key] = true
        }
        return {
          agentStatusByPaneKey: removePaneKeys(s.agentStatusByPaneKey, retiredPaneKeySet),
          runtimeAgentOrchestrationByPaneKey: removePaneKeys(
            s.runtimeAgentOrchestrationByPaneKey,
            retiredPaneKeySet
          ),
          retainedAgentsByPaneKey: removePaneKeys(s.retainedAgentsByPaneKey, retiredPaneKeySet),
          sleepingAgentSessionsByPaneKey: removePaneKeys(
            s.sleepingAgentSessionsByPaneKey,
            retiredPaneKeySet
          ),
          agentLaunchConfigByPaneKey: removePaneKeys(
            s.agentLaunchConfigByPaneKey,
            retiredPaneKeySet
          ),
          acknowledgedAgentsByPaneKey: removePaneKeys(
            s.acknowledgedAgentsByPaneKey,
            retiredPaneKeySet
          ),
          paneForegroundAgentByPaneKey: removePaneKeys(
            s.paneForegroundAgentByPaneKey,
            retiredPaneKeySet
          ),
          unreadTerminalPanes: removePaneKeys(s.unreadTerminalPanes, retiredPaneKeySet),
          unreadAgentCompletionPanes: removePaneKeys(
            s.unreadAgentCompletionPanes,
            retiredPaneKeySet
          ),
          lastTerminalInputAtByPaneKey: removePaneKeys(
            s.lastTerminalInputAtByPaneKey,
            retiredPaneKeySet
          ),
          cacheTimerByKey: removePaneKeys(s.cacheTimerByKey, retiredPaneKeySet),
          retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
          recentlyRetiredAgentStatusPaneKeys: boundRecentlyRetiredAgentStatusPaneKeys(
            s.recentlyRetiredAgentStatusPaneKeys,
            retiredPaneKeys
          ),
          agentStatusEpoch: hadLive ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: hadLive ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.retirePaneAuthority?.(ownerPaneKey)
      }
    },

    transferAgentPaneAuthority: ({ fromPaneKey, toPaneKey, ptyId }) => {
      const transfer = transferAgentPaneAuthorityAlias({ fromPaneKey, toPaneKey, ptyId })
      if (!transfer || transfer.previousOwnerPaneKey === transfer.ownerPaneKey) {
        return
      }
      const from = transfer.previousOwnerPaneKey
      const to = transfer.ownerPaneKey
      const targetTabId = getTabIdFromPaneKey(to) ?? undefined
      const targetLeafId = getLeafIdFromPaneKey(to) ?? undefined
      set((s) => ({
        agentStatusByPaneKey: movePaneKeyedRecord(s.agentStatusByPaneKey, from, to, (entry) => ({
          ...entry,
          paneKey: to,
          tabId: targetTabId
        })),
        runtimeAgentOrchestrationByPaneKey: movePaneKeyedRecord(
          s.runtimeAgentOrchestrationByPaneKey,
          from,
          to
        ),
        retainedAgentsByPaneKey: movePaneKeyedRecord(
          s.retainedAgentsByPaneKey,
          from,
          to,
          (retained) => ({
            ...retained,
            entry: { ...retained.entry, paneKey: to, tabId: targetTabId },
            tab: targetTabId ? { ...retained.tab, id: targetTabId } : retained.tab
          })
        ),
        sleepingAgentSessionsByPaneKey: movePaneKeyedRecord(
          s.sleepingAgentSessionsByPaneKey,
          from,
          to,
          (record) => ({ ...record, paneKey: to, tabId: targetTabId })
        ),
        agentLaunchConfigByPaneKey: movePaneKeyedRecord(
          s.agentLaunchConfigByPaneKey,
          from,
          to,
          (entry) => ({
            ...entry,
            identity: { ...entry.identity, tabId: targetTabId, leafId: targetLeafId }
          })
        ),
        acknowledgedAgentsByPaneKey: movePaneKeyedRecord(s.acknowledgedAgentsByPaneKey, from, to),
        paneForegroundAgentByPaneKey: movePaneKeyedRecord(s.paneForegroundAgentByPaneKey, from, to),
        unreadTerminalPanes: movePaneKeyedRecord(s.unreadTerminalPanes, from, to),
        unreadAgentCompletionPanes: movePaneKeyedRecord(s.unreadAgentCompletionPanes, from, to),
        lastTerminalInputAtByPaneKey: movePaneKeyedRecord(s.lastTerminalInputAtByPaneKey, from, to),
        cacheTimerByKey: movePaneKeyedRecord(s.cacheTimerByKey, from, to),
        retentionSuppressedPaneKeys: movePaneKeyedRecord(s.retentionSuppressedPaneKeys, from, to)
      }))
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.transferPaneAuthority?.({
          fromPaneKey: from,
          toPaneKey: to,
          ...(transfer.ptyId ? { ptyId: transfer.ptyId } : {})
        })
      }
    },

    setRuntimeAgentOrchestrationByPaneKey: (entries) => {
      const generatedTitleUpdates: AgentStatusEntry[] = []
      set((s) => {
        const runtimeMapChanged = !orchestrationMapsEqual(
          s.runtimeAgentOrchestrationByPaneKey,
          entries
        )
        let nextLive = s.agentStatusByPaneKey
        let liveChanged = false
        let nextRetained = s.retainedAgentsByPaneKey
        let retainedChanged = false

        for (const [paneKey, runtimeOrchestration] of Object.entries(entries)) {
          const liveEntry = nextLive[paneKey]
          if (liveEntry) {
            const merged = mergeCurrentOrchestrationContext(
              liveEntry.orchestration,
              runtimeOrchestration
            )
            if (merged !== liveEntry.orchestration) {
              if (!liveChanged) {
                nextLive = { ...nextLive }
                liveChanged = true
              }
              const nextEntry = { ...liveEntry, orchestration: merged }
              nextLive[paneKey] = nextEntry
              // Why: only replace titles when labels match the live dispatch taskId; sticky completed context must not rename a later turn.
              if (
                (merged.displayName?.trim() || merged.taskTitle?.trim()) &&
                orchestrationLabelsMatchLiveDispatch({
                  prompt: nextEntry.prompt,
                  orchestration: merged
                })
              ) {
                generatedTitleUpdates.push(nextEntry)
              }
            }
          }

          const retainedEntry = nextRetained[paneKey]
          if (retainedEntry) {
            const merged = mergeCurrentOrchestrationContext(
              retainedEntry.entry.orchestration,
              runtimeOrchestration
            )
            if (merged !== retainedEntry.entry.orchestration) {
              if (!retainedChanged) {
                nextRetained = { ...nextRetained }
                retainedChanged = true
              }
              nextRetained[paneKey] = {
                ...retainedEntry,
                entry: { ...retainedEntry.entry, orchestration: merged }
              }
            }
          }
        }

        if (!runtimeMapChanged && !liveChanged && !retainedChanged) {
          return s
        }

        return {
          ...(runtimeMapChanged ? { runtimeAgentOrchestrationByPaneKey: entries } : {}),
          ...(liveChanged ? { agentStatusByPaneKey: nextLive } : {}),
          ...(retainedChanged ? { retainedAgentsByPaneKey: nextRetained } : {}),
          ...(liveChanged ? { agentStatusEpoch: s.agentStatusEpoch + 1 } : {})
        }
      })
      for (const entry of generatedTitleUpdates) {
        get().setGeneratedTabTitleFromAgentPrompt(
          entry.paneKey,
          getAgentRowGeneratedTitleText(entry),
          {
            replaceExistingGeneratedTitle: true
          }
        )
      }
    },

    registerAgentLaunchConfig: (paneKey, launchConfig, metadata) => {
      set((s) => {
        const copiedLaunchConfig = copyLaunchConfig(launchConfig)
        const nextRegistryEntry: AgentLaunchConfigRegistryEntry = {
          launchConfig: copiedLaunchConfig,
          registeredAt: Date.now(),
          identity: normalizeLaunchConfigRegistrationMetadata(paneKey, metadata)
        }
        const existingRegistryEntry = s.agentLaunchConfigByPaneKey[paneKey]
        const registryChanged = !launchConfigRegistryEntriesEqual(
          existingRegistryEntry,
          nextRegistryEntry
        )
        const existingEntry = s.agentStatusByPaneKey[paneKey]
        const entryMatchesRegistry = registryEntryMatchesStatus({
          entry: nextRegistryEntry,
          paneKey,
          agentType: existingEntry?.agentType,
          tabId: existingEntry?.tabId ?? getTabIdFromPaneKey(paneKey) ?? undefined,
          terminalHandle: existingEntry?.terminalHandle,
          launchToken: metadata?.launchToken,
          providerSession: existingEntry?.providerSession,
          existingProviderSession: existingEntry?.providerSession,
          providerSessionChanged: false
        })
        const existingSleepingRecord = s.sleepingAgentSessionsByPaneKey[paneKey]
        let nextSleepingAgentSessions = s.sleepingAgentSessionsByPaneKey
        if (existingSleepingRecord && entryMatchesRegistry && existingEntry) {
          const worktreeId =
            existingEntry.worktreeId ??
            existingSleepingRecord.worktreeId ??
            findAgentPaneWorktreeId(s, paneKey)
          const refreshedRecord = worktreeId
            ? sleepingRecordFromEntry({
                state: s,
                entry: existingEntry,
                worktreeId,
                capturedAt: existingSleepingRecord.capturedAt,
                launchConfig: copiedLaunchConfig,
                origin: existingSleepingRecord.origin
              })
            : null
          if (refreshedRecord) {
            nextSleepingAgentSessions = {
              ...s.sleepingAgentSessionsByPaneKey,
              [paneKey]: {
                ...refreshedRecord,
                capturedAt: existingSleepingRecord.capturedAt
              }
            }
          }
        }
        if (!registryChanged && nextSleepingAgentSessions === s.sleepingAgentSessionsByPaneKey) {
          return s
        }
        return {
          ...(registryChanged
            ? {
                agentLaunchConfigByPaneKey: {
                  ...s.agentLaunchConfigByPaneKey,
                  [paneKey]: nextRegistryEntry
                }
              }
            : {}),
          ...(nextSleepingAgentSessions !== s.sleepingAgentSessionsByPaneKey
            ? { sleepingAgentSessionsByPaneKey: nextSleepingAgentSessions }
            : {})
        }
      })
    },
    getAgentLaunchConfigForStatusEntry: (entry) => getLaunchConfigForEntry(get(), entry),
    getAgentLaunchConfigForStatusMetadata: (metadata) =>
      getLaunchConfigForStatusMetadata(get(), metadata),

    clearAgentLaunchConfig: (paneKey) => {
      set((s) => {
        if (!(paneKey in s.agentLaunchConfigByPaneKey)) {
          return s
        }
        const nextLaunchConfigs = { ...s.agentLaunchConfigByPaneKey }
        delete nextLaunchConfigs[paneKey]
        return { agentLaunchConfigByPaneKey: nextLaunchConfigs }
      })
    },

    recordAgentProviderSession: (paneKey, agent, providerSession, timing, routing, metadata) => {
      paneKey = resolveAgentPaneAuthorityKey(paneKey)
      const updatedAt = timing?.updatedAt ?? Date.now()
      if (
        paneKey in get().recentlyRetiredAgentStatusPaneKeys ||
        isRecentlyClosedAgentStatusTab(
          get().recentlyClosedAgentStatusTabIds,
          getTabIdFromPaneKey(paneKey)
        ) ||
        !getAgentResumeArgv(agent, providerSession)
      ) {
        return
      }
      let removedLiveStatus = false
      set((s) => {
        const existingStatus = s.agentStatusByPaneKey[paneKey]
        const existingRecord = s.sleepingAgentSessionsByPaneKey[paneKey]
        if (
          (existingStatus && updatedAt < existingStatus.updatedAt) ||
          (existingRecord && updatedAt < existingRecord.updatedAt)
        ) {
          return s
        }
        const tabId = routing?.tabId ?? getTabIdFromPaneKey(paneKey) ?? existingRecord?.tabId
        const worktreeId =
          routing?.worktreeId ??
          existingStatus?.worktreeId ??
          existingRecord?.worktreeId ??
          findAgentPaneWorktreeId(s, paneKey)
        if (!worktreeId) {
          return s
        }
        const registryEntry = s.agentLaunchConfigByPaneKey[paneKey]
        const registryMatches = registryEntryMatchesStatus({
          entry: registryEntry,
          paneKey,
          agentType: agent,
          tabId,
          terminalHandle: undefined,
          launchToken: metadata?.launchToken,
          providerSession,
          existingProviderSession: existingRecord?.providerSession,
          providerSessionChanged: false
        })
        const launchConfig =
          (registryMatches ? registryEntry?.launchConfig : undefined) ??
          (existingRecord?.agent === agent &&
          agentProviderSessionsEqual(agent, existingRecord.providerSession, providerSession)
            ? existingRecord.launchConfig
            : undefined)
        const record: SleepingAgentSessionRecord = {
          paneKey,
          ...(tabId ? { tabId } : {}),
          worktreeId,
          agent,
          providerSession,
          prompt: '',
          // Why: durable process/session identity, not visible turn state; a non-done value keeps cold restore eligible.
          state: 'working',
          capturedAt: updatedAt,
          updatedAt,
          ...(existingStatus?.terminalTitle
            ? { terminalTitle: existingStatus.terminalTitle }
            : existingRecord?.terminalTitle
              ? { terminalTitle: existingRecord.terminalTitle }
              : {}),
          ...(routing?.connectionId !== undefined
            ? { connectionId: routing.connectionId }
            : existingRecord?.connectionId !== undefined
              ? { connectionId: existingRecord.connectionId }
              : {}),
          ...(launchConfig ? { launchConfig: copyLaunchConfig(launchConfig) } : {}),
          origin: 'live'
        }
        removedLiveStatus = existingStatus !== undefined
        const nextLive = removedLiveStatus ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        if (removedLiveStatus) {
          delete nextLive[paneKey]
        }
        const nextRetained =
          paneKey in s.retainedAgentsByPaneKey
            ? { ...s.retainedAgentsByPaneKey }
            : s.retainedAgentsByPaneKey
        if (nextRetained !== s.retainedAgentsByPaneKey) {
          delete nextRetained[paneKey]
        }
        // Why: on identity mismatch the sleeping record drops its launch config, so clear the stale
        // registry entry too, else a later return to the old identity reuses stale args/env.
        let nextLaunchConfigs = s.agentLaunchConfigByPaneKey
        if (registryMatches && registryEntry) {
          nextLaunchConfigs = {
            ...nextLaunchConfigs,
            [paneKey]: {
              ...registryEntry,
              identity: { ...registryEntry.identity, providerSession }
            }
          }
        } else if (registryEntry) {
          nextLaunchConfigs = { ...nextLaunchConfigs }
          delete nextLaunchConfigs[paneKey]
        }
        return {
          agentStatusByPaneKey: nextLive,
          retainedAgentsByPaneKey: nextRetained,
          sleepingAgentSessionsByPaneKey: {
            ...s.sleepingAgentSessionsByPaneKey,
            [paneKey]: record
          },
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          acknowledgedAgentsByPaneKey: removePaneKeys(
            s.acknowledgedAgentsByPaneKey,
            new Set([paneKey])
          ),
          unreadAgentCompletionPanes: removePaneKeys(
            s.unreadAgentCompletionPanes,
            new Set([paneKey])
          ),
          agentStatusEpoch: removedLiveStatus ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: removedLiveStatus ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (removedLiveStatus) {
        queueMicrotask(() => freshness.schedule())
      }
    },

    setAgentStatus: (paneKey, payload, terminalTitle, timing, routing, metadata) => {
      paneKey = resolveAgentPaneAuthorityKey(paneKey)
      const updatedAt = timing?.updatedAt ?? Date.now()
      if (
        paneKey in get().recentlyRetiredAgentStatusPaneKeys ||
        // Why: a closed tab is no longer a valid destination for hook replays or late status events.
        isRecentlyClosedAgentStatusTab(
          get().recentlyClosedAgentStatusTabIds,
          getTabIdFromPaneKey(paneKey)
        )
      ) {
        return
      }
      let completionRefreshWorktreeId: string | null = null
      let suppressedInheritedTerminalStatus = false
      const generatedTitleEntry: { current: AgentStatusEntry | null } = { current: null }
      set((s) => {
        const existing = s.agentStatusByPaneKey[paneKey]
        // Why: snapshots and live pushes share one timestamp source, so equal timestamps carry
        // identical data; strict < preserves same-millisecond live-after-live updates.
        if (existing && updatedAt < existing.updatedAt) {
          return s
        }
        // Why: terminalTitle labels the pane itself, not the turn, so a missing title means "no update" —
        // preserve the prior value to avoid flicker (unlike tool/prompt fields, which clear on a fresh turn).
        const effectiveTitle = terminalTitle ?? existing?.terminalTitle

        // Rolling log of state transitions for the dashboard's activity blocks; push only on
        // real state changes to avoid dupes from prompt-only pings within the same state.
        let history: AgentStateHistoryEntry[] = existing?.stateHistory ?? []
        if (existing && existing.state !== payload.state) {
          history = [
            ...history,
            {
              state: existing.state,
              prompt: existing.prompt,
              // Why: use stateStartedAt (not updatedAt) so the row reflects when the state was first reported, not the latest within-state ping.
              startedAt: existing.stateStartedAt,
              // Why: preserve the interrupt flag on the historical `done` entry so activity-block views can render past cancellations.
              interrupted: existing.interrupted
            }
          ]
          if (history.length > AGENT_STATE_HISTORY_MAX) {
            history = history.slice(history.length - AGENT_STATE_HISTORY_MAX)
          }
        }

        const identity = resolveAgentStatusIdentity({
          existing: existing
            ? {
                agentType: existing.agentType,
                state: existing.state,
                updatedAt: existing.updatedAt
              }
            : undefined,
          incoming: payload.agentType,
          now: updatedAt
        })
        // Why: Command Code has no UserPromptSubmit; a fresh transcript prompt while still `working` is the smart-sort turn boundary.
        const commandCodeNewTurn =
          existing !== undefined &&
          isCommandCodeNewTurnWhileWorking({
            agentType: identity.agentType,
            previousState: existing.state,
            incomingState: payload.state,
            previousPrompt: existing.prompt,
            incomingPrompt: payload.prompt,
            previousPromptInteractionKey: existing.promptInteractionKey,
            incomingPromptInteractionKey: payload.promptInteractionKey
          })
        const promptInteractionKey =
          payload.promptInteractionKey ??
          (payload.prompt === existing?.prompt ? existing?.promptInteractionKey : undefined)
        // Why: prefer main's authoritative stateStartedAt (attachStatusTiming persists it across
        // same-state pings and restart); fall back to existing only when main sent no timing, updatedAt for a new pane.
        const stateStartedAt =
          timing?.stateStartedAt ??
          (commandCodeNewTurn
            ? updatedAt
            : existing && existing.state === payload.state
              ? existing.stateStartedAt
              : updatedAt)
        if (
          existing &&
          shouldSuppressInheritedTerminalStatus({
            inheritedFromActivePane: identity.inheritedFromActivePane,
            incomingState: payload.state
          })
        ) {
          suppressedInheritedTerminalStatus = true
          return s
        }

        // Why: tool/assistant fields arrive pre-merged and authoritative from main (resolveToolState
        // in server.ts), so write them through directly — no fallback — so UserPromptSubmit clears stale tool lines.
        const runtimeOrchestration = s.runtimeAgentOrchestrationByPaneKey[paneKey]
        const runtimeMergedOrchestration = runtimeOrchestration
          ? mergeCurrentOrchestrationContext(existing?.orchestration, runtimeOrchestration)
          : undefined
        const payloadMergedOrchestration = payload.orchestration
          ? mergeCurrentOrchestrationContext(
              runtimeMergedOrchestration ?? existing?.orchestration,
              payload.orchestration
            )
          : undefined
        const completedFallbackOrchestration =
          payload.state === 'done' ? existing?.orchestration : undefined
        const orchestration =
          payloadMergedOrchestration ?? runtimeMergedOrchestration ?? completedFallbackOrchestration
        // Why: waiting/blocked are still the same resumable turn; child permission hooks omit the root session id.
        const canReuseExistingProviderSession =
          existing?.agentType === identity.agentType &&
          existing.state !== 'done' &&
          payload.state !== 'done'
        const providerSession =
          metadata?.providerSession ??
          (canReuseExistingProviderSession ? existing.providerSession : undefined)
        const existingProviderSession = canReuseExistingProviderSession
          ? existing.providerSession
          : undefined
        const providerSessionChanged =
          Boolean(metadata?.providerSession && existingProviderSession) &&
          !agentProviderSessionsEqual(
            identity.agentType,
            metadata?.providerSession,
            existingProviderSession
          )
        const statusTabId =
          routing?.tabId ?? existing?.tabId ?? getTabIdFromPaneKey(paneKey) ?? undefined
        const statusTerminalHandle = routing?.terminalHandle ?? existing?.terminalHandle
        const registryEntry = s.agentLaunchConfigByPaneKey[paneKey]
        const matchedRegistryLaunchConfig = registryEntryMatchesStatus({
          entry: registryEntry,
          paneKey,
          agentType: identity.agentType,
          tabId: statusTabId,
          terminalHandle: statusTerminalHandle,
          launchToken: metadata?.launchToken,
          providerSession,
          existingProviderSession,
          providerSessionChanged
        })
          ? registryEntry?.launchConfig
          : undefined
        const existingSleepingRecord = s.sleepingAgentSessionsByPaneKey[paneKey]
        const retainsPiRecoveryIdentity =
          payload.state === 'done' &&
          identity.agentType === 'pi' &&
          providerSession !== undefined &&
          getAgentResumeArgv('pi', providerSession) !== null
        const matchedSleepingLaunchConfig =
          (payload.state !== 'done' || retainsPiRecoveryIdentity) &&
          existingSleepingRecord?.launchConfig &&
          existingSleepingRecord.agent === identity.agentType &&
          providerSession &&
          agentProviderSessionsEqual(
            identity.agentType,
            existingSleepingRecord.providerSession,
            providerSession
          )
            ? existingSleepingRecord.launchConfig
            : undefined
        // Why: on a reused pane key, once the provider session changes the old launch registry must not bleed options into the new session.
        const launchConfigSource =
          (payload.state !== 'done' && !providerSessionChanged && metadata?.launchToken
            ? metadata?.launchConfig
            : undefined) ??
          matchedRegistryLaunchConfig ??
          matchedSleepingLaunchConfig
        const entry: AgentStatusEntry = {
          state: payload.state,
          prompt: payload.prompt,
          updatedAt,
          stateStartedAt,
          agentType: identity.agentType,
          model:
            payload.model ??
            (existing?.agentType === identity.agentType ? existing.model : undefined),
          paneKey,
          terminalHandle: statusTerminalHandle,
          worktreeId:
            routing?.worktreeId ??
            existing?.worktreeId ??
            findAgentPaneWorktreeId(s, paneKey) ??
            undefined,
          ...(routing?.connectionId !== undefined
            ? { connectionId: routing.connectionId }
            : existing?.connectionId !== undefined
              ? { connectionId: existing.connectionId }
              : {}),
          tabId: statusTabId,
          terminalTitle: effectiveTitle,
          stateHistory: history,
          toolName: payload.toolName,
          toolInput: payload.toolInput,
          // Why: full untruncated AskUserQuestion JSON so mobile/web can render the live prompt
          // card; parseAgentStatusPayload clears it on tool/state change.
          interactivePrompt: payload.interactivePrompt,
          lastAssistantMessage: payload.lastAssistantMessage,
          // Why: reused panes can start non-orchestrated work; only final done rows keep the
          // previous lineage fallback so completed children stay grouped.
          orchestration,
          // Why: reuse the prior array ref when the roster is unchanged so identity-comparing subscribers skip re-renders.
          subagents: agentSubagentsEqual(existing?.subagents, payload.subagents)
            ? existing?.subagents
            : payload.subagents,
          ...(providerSession ? { providerSession } : {}),
          ...(promptInteractionKey ? { promptInteractionKey } : {}),
          // Why: `interrupted` is done-only; parseAgentStatusPayload already clamps it for non-done states, so write it through directly.
          interrupted: payload.interrupted
        }
        generatedTitleEntry.current = entry
        if (
          isAgentCompletionState(entry.state) &&
          existing !== undefined &&
          !isAgentCompletionState(existing.state)
        ) {
          completionRefreshWorktreeId = entry.worktreeId ?? findAgentPaneWorktreeId(s, paneKey)
        }
        // Why: emit a global tick only when an entry appears, changes state, crosses stale→fresh,
        // or is a same-state `done` update — same-state working pings must not fan out to aggregates.
        const wasFresh =
          !!existing && isExplicitAgentStatusFresh(existing, updatedAt, AGENT_STATUS_STALE_AFTER_MS)
        // Why: a late main-process attribution stamp can change which workspace stays visible without changing agent state.
        const attributionChanged =
          existing?.worktreeId !== entry.worktreeId || existing?.tabId !== entry.tabId
        // Why: main can advance stateStartedAt on a same-state turn boundary the renderer
        // missed; treat that as sort-relevant so smart sort never goes stale.
        // Non-Command-Code agents never advance stateStartedAt at a fixed state, so this stays CC-scoped.
        const sameStateStateStartedAtChanged =
          !!existing &&
          existing.state === payload.state &&
          entry.stateStartedAt !== existing.stateStartedAt
        const sortRelevantChange =
          !existing ||
          existing.state !== payload.state ||
          !wasFresh ||
          attributionChanged ||
          commandCodeNewTurn ||
          sameStateStateStartedAtChanged
        const doneRetentionFieldsChanged =
          existing?.state === 'done' &&
          entry.state === 'done' &&
          (entry.prompt !== existing.prompt ||
            entry.updatedAt !== existing.updatedAt ||
            entry.stateStartedAt !== existing.stateStartedAt ||
            entry.agentType !== existing.agentType ||
            entry.model !== existing.model ||
            entry.terminalTitle !== existing.terminalTitle ||
            entry.toolName !== existing.toolName ||
            entry.toolInput !== existing.toolInput ||
            entry.lastAssistantMessage !== existing.lastAssistantMessage ||
            entry.orchestration !== existing.orchestration ||
            entry.subagents !== existing.subagents ||
            entry.providerSession !== existing.providerSession ||
            entry.interrupted !== existing.interrupted)
        const retentionRelevantChange =
          sortRelevantChange || attributionChanged || doneRetentionFieldsChanged
        // Why: a fresh status means the agent is live again — lift its one-shot retention suppressor.
        // Clone the map only when a suppressor exists, else every high-frequency ping churns the ref.
        const hasSuppressor = paneKey in s.retentionSuppressedPaneKeys
        let nextRetentionSuppressedPaneKeys = s.retentionSuppressedPaneKeys
        if (hasSuppressor) {
          nextRetentionSuppressedPaneKeys = { ...s.retentionSuppressedPaneKeys }
          delete nextRetentionSuppressedPaneKeys[paneKey]
        }
        // Why: pane keys are reused across turns, so a fresh live row makes any retained snapshot stale — drop it so it doesn't render beside the live row.
        const hasRetainedSnapshot = paneKey in s.retainedAgentsByPaneKey
        const nextRetainedAgents = hasRetainedSnapshot
          ? { ...s.retainedAgentsByPaneKey }
          : s.retainedAgentsByPaneKey
        if (hasRetainedSnapshot) {
          delete nextRetainedAgents[paneKey]
        }
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey === paneKey
        )
        const liveRecoveryWorktreeId =
          entry.state === 'done' && !retainsPiRecoveryIdentity
            ? null
            : (entry.worktreeId ?? findAgentPaneWorktreeId(s, entry.paneKey))
        const liveRecoveryRecord = liveRecoveryWorktreeId
          ? sleepingRecordFromEntry({
              state: s,
              // Why: a completed Pi turn leaves the TUI session alive — keep resume identity active without representing done as pending work.
              entry: retainsPiRecoveryIdentity
                ? { ...entry, state: 'working', prompt: '', lastAssistantMessage: undefined }
                : entry,
              worktreeId: liveRecoveryWorktreeId,
              capturedAt: updatedAt,
              launchConfig: launchConfigSource,
              origin: 'live'
            })
          : null
        let nextSleepingAgentSessions = s.sleepingAgentSessionsByPaneKey
        let nextLaunchConfigs = s.agentLaunchConfigByPaneKey
        if (
          matchedRegistryLaunchConfig &&
          registryEntry &&
          providerSession &&
          !agentProviderSessionsEqual(
            identity.agentType,
            registryEntry.identity.providerSession,
            providerSession
          )
        ) {
          nextLaunchConfigs = {
            ...nextLaunchConfigs,
            [paneKey]: {
              ...registryEntry,
              identity: {
                ...registryEntry.identity,
                providerSession
              }
            }
          }
        }
        // Why: launch tokens can outlive an Orca-started TUI in the shell; once the session is done they must no longer authorize config reuse.
        if (
          (providerSessionChanged || entry.state === 'done') &&
          paneKey in s.agentLaunchConfigByPaneKey
        ) {
          nextLaunchConfigs = { ...s.agentLaunchConfigByPaneKey }
          delete nextLaunchConfigs[paneKey]
        }
        if (liveRecoveryRecord) {
          if (!recoveryRecordMatches(existingSleepingRecord, liveRecoveryRecord)) {
            nextSleepingAgentSessions = {
              ...s.sleepingAgentSessionsByPaneKey,
              [paneKey]: liveRecoveryRecord
            }
          }
        } else if (existingSleepingRecord) {
          nextSleepingAgentSessions = { ...s.sleepingAgentSessionsByPaneKey }
          delete nextSleepingAgentSessions[paneKey]
        }
        const nextLive = { ...s.agentStatusByPaneKey, [paneKey]: entry }
        // Why: cap the live map so a huge map's per-ping spread copy can't OOM the renderer (#9872).
        const evictedPaneKeys = capLiveAgentStatusesInPlace(
          nextLive,
          paneKey,
          () => classifyPaneKeyLiveness(s),
          updatedAt
        )
        const evictedOrphans = evictedPaneKeys.length > 0
        if (evictedOrphans) {
          const evictedPaneKeySet = new Set(evictedPaneKeys)
          nextSleepingAgentSessions = removePaneKeys(nextSleepingAgentSessions, evictedPaneKeySet)
          nextLaunchConfigs = removePaneKeys(nextLaunchConfigs, evictedPaneKeySet)
        }
        return {
          agentStatusByPaneKey: nextLive,
          retainedAgentsByPaneKey: nextRetainedAgents,
          sleepingAgentSessionsByPaneKey: nextSleepingAgentSessions,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
          agentStatusEpoch:
            retentionRelevantChange || migrationUnsupported.changed || evictedOrphans
              ? s.agentStatusEpoch + 1
              : s.agentStatusEpoch,
          sortEpoch:
            sortRelevantChange || migrationUnsupported.changed || evictedOrphans
              ? s.sortEpoch + 1
              : s.sortEpoch
        }
      })
      if (suppressedInheritedTerminalStatus) {
        return
      }
      const entryForGeneratedTitle = generatedTitleEntry.current
      if (entryForGeneratedTitle) {
        // Why: sticky orchestration (~30m) can outlive the dispatch turn, so replace the title on matching labels or a re-dispatch's mismatched taskId.
        const hasMatchingOrchestrationLabels = Boolean(
          (entryForGeneratedTitle.orchestration?.displayName?.trim() ||
            entryForGeneratedTitle.orchestration?.taskTitle?.trim()) &&
          orchestrationLabelsMatchLiveDispatch(entryForGeneratedTitle)
        )
        const liveIsDispatchPrompt = isOrcaDispatchPrompt(entryForGeneratedTitle.prompt)
        const liveDispatchTaskId = liveIsDispatchPrompt
          ? getOrcaDispatchTaskId(entryForGeneratedTitle.prompt)
          : null
        const stickyOrchestrationTaskId =
          entryForGeneratedTitle.orchestration?.taskId?.trim() || null
        const isNewDispatchAgainstStickyOrchestration = Boolean(
          liveDispatchTaskId &&
          stickyOrchestrationTaskId &&
          liveDispatchTaskId !== stickyOrchestrationTaskId
        )
        const shouldReplaceGeneratedTitle =
          hasMatchingOrchestrationLabels || isNewDispatchAgainstStickyOrchestration
        // Why: setAgentStatus is high-frequency, so only parse dispatch preambles when a title write is actually possible.
        const mayWriteGeneratedTitle =
          get().settings?.tabAutoGenerateTitle === true &&
          (shouldReplaceGeneratedTitle ||
            !agentStatusTabAlreadyHasProtectedOrGeneratedTitle(
              get(),
              entryForGeneratedTitle.tabId ?? getTabIdFromPaneKey(paneKey),
              entryForGeneratedTitle.worktreeId
            ))
        const generatedTitlePrompt =
          liveIsDispatchPrompt && mayWriteGeneratedTitle
            ? getAgentRowGeneratedTitleText(entryForGeneratedTitle)
            : entryForGeneratedTitle.prompt
        if (shouldReplaceGeneratedTitle) {
          get().setGeneratedTabTitleFromAgentPrompt(paneKey, generatedTitlePrompt, {
            replaceExistingGeneratedTitle: true
          })
        } else {
          get().setGeneratedTabTitleFromAgentPrompt(paneKey, generatedTitlePrompt)
        }
      }
      // Why: schedule via queueMicrotask after set so the timer reads the updated map without re-entering the store during set.
      queueMicrotask(() => freshness.schedule())
      if (completionRefreshWorktreeId) {
        const worktreeId = completionRefreshWorktreeId
        // Why: agents can create a PR via `gh pr create`, bypassing Orca's flow and leaving a stale "no PR" cache entry in place.
        queueMicrotask(() => get().refreshGitHubForWorktreeIfStale(worktreeId))
      }
    },

    setMigrationUnsupportedPty: (entry) => {
      set((s) => {
        const existing = s.migrationUnsupportedByPtyId[entry.ptyId]
        if (existing && entry.updatedAt < existing.updatedAt) {
          return s
        }
        return {
          migrationUnsupportedByPtyId: {
            ...s.migrationUnsupportedByPtyId,
            [entry.ptyId]: entry
          },
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
    },

    clearMigrationUnsupportedPty: (ptyId) => {
      if (!(ptyId in get().migrationUnsupportedByPtyId)) {
        return
      }
      set((s) => {
        const next = { ...s.migrationUnsupportedByPtyId }
        delete next[ptyId]
        return {
          migrationUnsupportedByPtyId: next,
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
    },

    removeAgentStatus: (paneKey) => {
      if (
        !(paneKey in get().agentStatusByPaneKey) &&
        !(paneKey in get().agentLaunchConfigByPaneKey) &&
        !Object.values(get().migrationUnsupportedByPtyId).some((entry) => entry.paneKey === paneKey)
      ) {
        return
      }
      set((s) => {
        const hasLive = paneKey in s.agentStatusByPaneKey
        const next = hasLive ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        if (hasLive) {
          delete next[paneKey]
        }
        const hasLaunchConfig = paneKey in s.agentLaunchConfigByPaneKey
        const nextLaunchConfigs = hasLaunchConfig
          ? { ...s.agentLaunchConfigByPaneKey }
          : s.agentLaunchConfigByPaneKey
        if (hasLaunchConfig) {
          delete nextLaunchConfigs[paneKey]
        }
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey === paneKey
        )
        // Why: drop the ack entry with the pane so a future paneKey collision can't inherit a stale ack that suppresses "unvisited" signals.
        let nextAck = s.acknowledgedAgentsByPaneKey
        if (paneKey in nextAck) {
          nextAck = { ...nextAck }
          delete nextAck[paneKey]
        }
        // Why: bump sortEpoch with agentStatusEpoch — removing an agent can change worktree sort order (same as setAgentStatus).
        return {
          agentStatusByPaneKey: next,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
      queueMicrotask(() => freshness.schedule())
    },

    removeAgentStatusByTabPrefix: (tabIdPrefix) => {
      const prefix = `${tabIdPrefix}:`
      const currentKeys = Object.keys(get().agentStatusByPaneKey)
      const toRemove = currentKeys.filter((k) => k.startsWith(prefix))
      const launchConfigKeys = Object.keys(get().agentLaunchConfigByPaneKey).filter((k) =>
        k.startsWith(prefix)
      )
      const hasMigrationUnsupported = Object.values(get().migrationUnsupportedByPtyId).some(
        (entry) => entry.paneKey?.startsWith(prefix)
      )
      if (toRemove.length === 0 && launchConfigKeys.length === 0 && !hasMigrationUnsupported) {
        return
      }
      set((s) => {
        const next = { ...s.agentStatusByPaneKey }
        for (const key of toRemove) {
          delete next[key]
        }
        const nextLaunchConfigs = { ...s.agentLaunchConfigByPaneKey }
        for (const key of launchConfigKeys) {
          delete nextLaunchConfigs[key]
        }
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey?.startsWith(prefix) ?? false
        )
        // See removeAgentStatus for rationale on ack cleanup.
        let nextAck = s.acknowledgedAgentsByPaneKey
        const ackKeys = Object.keys(nextAck).filter((k) => k.startsWith(prefix))
        if (ackKeys.length > 0) {
          nextAck = { ...nextAck }
          for (const k of ackKeys) {
            delete nextAck[k]
          }
        }
        // Why: bump sortEpoch with agentStatusEpoch — removing agents can change worktree sort order (same as setAgentStatus).
        return {
          agentStatusByPaneKey: next,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
      queueMicrotask(() => freshness.schedule())
    },

    clearTransientAgentStatuses: (connectionId, clearedAt) => {
      if (connectionId.length === 0 || !Number.isFinite(clearedAt)) {
        return
      }
      let removed = false
      set((s) => {
        const worktreeIdsOnConnection = collectWorktreeIdsForConnection(s, connectionId)
        let next: Record<string, AgentStatusEntry> | null = null
        for (const [paneKey, existing] of Object.entries(s.agentStatusByPaneKey)) {
          if (existing.updatedAt > clearedAt) {
            continue
          }
          // Why: clear rows stamped for this connection, plus UNSTAMPED (never-stamped) worktree
          // rows unambiguously on it (#9030). An explicit stamp — another host's connectionId, or a
          // local `null` — is authoritative and never overridden by worktree inference.
          const belongsToConnection =
            existing.connectionId === connectionId ||
            (existing.connectionId === undefined &&
              existing.worktreeId !== undefined &&
              worktreeIdsOnConnection.has(existing.worktreeId))
          if (!belongsToConnection) {
            continue
          }
          next ??= { ...s.agentStatusByPaneKey }
          delete next[paneKey]
        }
        const wasAlreadyBlocked = connectionId in s.transientClearedAgentStatusConnectionIds
        if (!next && wasAlreadyBlocked) {
          return s
        }
        removed = next !== null
        // Why: transport loss is reversible. Keep launch, resume, retention,
        // and acknowledgement maps intact for same-pane relay replay.
        return {
          ...(next
            ? {
                agentStatusByPaneKey: next,
                agentStatusEpoch: s.agentStatusEpoch + 1,
                sortEpoch: s.sortEpoch + 1
              }
            : {}),
          transientClearedAgentStatusConnectionIds: wasAlreadyBlocked
            ? s.transientClearedAgentStatusConnectionIds
            : { ...s.transientClearedAgentStatusConnectionIds, [connectionId]: true }
        }
      })
      if (removed) {
        queueMicrotask(() => freshness.schedule())
      }
    },

    dropAgentStatus: (paneKey) => {
      // Why: zustand set is synchronous, so capture liveExisted once inside the callback instead of double-reading the store.
      let liveExisted = false
      set((s) => {
        const hasLive = paneKey in s.agentStatusByPaneKey
        liveExisted = hasLive
        const hasRetained = paneKey in s.retainedAgentsByPaneKey
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey === paneKey
        )
        // See removeAgentStatus for ack-cleanup rationale; the ack entry is owned by the pane lifecycle regardless of live/retained state.
        let nextAck = s.acknowledgedAgentsByPaneKey
        if (paneKey in nextAck) {
          nextAck = { ...nextAck }
          delete nextAck[paneKey]
        }
        const hasLaunchConfig = paneKey in s.agentLaunchConfigByPaneKey
        const nextLaunchConfigs = hasLaunchConfig
          ? { ...s.agentLaunchConfigByPaneKey }
          : s.agentLaunchConfigByPaneKey
        if (hasLaunchConfig) {
          delete nextLaunchConfigs[paneKey]
        }
        // Why: short-circuit when there's nothing to change, but still flush a pending ack or launch-config cleanup if one is present.
        if (!hasLive && !hasRetained && !migrationUnsupported.changed) {
          if (hasLaunchConfig) {
            return {
              agentLaunchConfigByPaneKey: nextLaunchConfigs,
              ...(nextAck !== s.acknowledgedAgentsByPaneKey
                ? { acknowledgedAgentsByPaneKey: nextAck }
                : {})
            }
          }
          if (nextAck !== s.acknowledgedAgentsByPaneKey) {
            return { acknowledgedAgentsByPaneKey: nextAck }
          }
          return s
        }

        const nextLive = hasLive ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        if (hasLive) {
          delete nextLive[paneKey]
        }
        const nextRetained = hasRetained
          ? { ...s.retainedAgentsByPaneKey }
          : s.retainedAgentsByPaneKey
        if (hasRetained) {
          delete nextRetained[paneKey]
        }

        // Why: explicit teardown must not let retention sync resurrect this row — plant a one-shot suppressor, but only when hasLive (a retained-only key has no live→gone transition to consume it, so it leaks) and not already present (re-spreading spuriously re-renders subscribers).
        const needsSuppressorWrite = hasLive && !(paneKey in s.retentionSuppressedPaneKeys)

        return {
          agentStatusByPaneKey: nextLive,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          retainedAgentsByPaneKey: nextRetained,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          ...(needsSuppressorWrite
            ? {
                retentionSuppressedPaneKeys: {
                  ...s.retentionSuppressedPaneKeys,
                  [paneKey]: true
                }
              }
            : {}),
          agentStatusEpoch:
            hasLive || migrationUnsupported.changed ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          // Why: mirrors removeAgentStatus — dropping a live agent changes its worktree sort score, so bump sortEpoch to recompute the sidebar smart-sort.
          sortEpoch: hasLive || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      // Why: freshness.schedule only matters when the live map changed, so gate on the live presence observed inside set() — no-op/retained-only drops skip it.
      if (liveExisted) {
        queueMicrotask(() => freshness.schedule())
      }
      // Why: propagate the dismissal to the main-process hook cache so the on-disk cache doesn't re-hydrate this row on next launch. Fire-and-forget.
      // Why: the typeof window guard keeps the slice usable from the node test env, where window is undefined.
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.drop?.(paneKey)
      }
    },

    dropAgentStatusByTabPrefix: (tabIdPrefix, opts) => {
      const prefix = `${tabIdPrefix}:`
      const retiredAliasPaneKeys = retireAgentPaneAuthorityAliasesByOwnerTab(tabIdPrefix)
      let hadLive = false
      set((s) => {
        const completedOrphanKeys = findCompletedOrphanPaneKeysForTabClose(
          s,
          opts?.worktreeId,
          prefix
        )
        const completedOrphanKeySet = new Set(completedOrphanKeys)
        const liveKeys = [
          ...Object.keys(s.agentStatusByPaneKey).filter((k) => k.startsWith(prefix)),
          ...completedOrphanKeys
        ]
        const launchConfigKeys = Object.keys(s.agentLaunchConfigByPaneKey).filter(
          (k) => k.startsWith(prefix) || completedOrphanKeySet.has(k)
        )
        const retainedKeys = Object.keys(s.retainedAgentsByPaneKey).filter(
          (k) => k.startsWith(prefix) || completedOrphanKeySet.has(k)
        )
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey?.startsWith(prefix) ?? false
        )
        // See removeAgentStatus for ack-cleanup rationale; ack entries are owned by the pane lifecycle regardless of live/retained state.
        let nextAck = s.acknowledgedAgentsByPaneKey
        const ackKeys = Object.keys(nextAck).filter(
          (k) => k.startsWith(prefix) || completedOrphanKeySet.has(k)
        )
        if (ackKeys.length > 0) {
          nextAck = { ...nextAck }
          for (const k of ackKeys) {
            delete nextAck[k]
          }
        }
        const nextClosedTabs = boundRecentlyClosedAgentStatusTabIds(
          s.recentlyClosedAgentStatusTabIds,
          tabIdPrefix
        )
        const nextRetiredPaneKeys = boundRecentlyRetiredAgentStatusPaneKeys(
          s.recentlyRetiredAgentStatusPaneKeys,
          retiredAliasPaneKeys
        )

        if (
          liveKeys.length === 0 &&
          launchConfigKeys.length === 0 &&
          retainedKeys.length === 0 &&
          !migrationUnsupported.changed
        ) {
          if (nextAck !== s.acknowledgedAgentsByPaneKey) {
            return {
              acknowledgedAgentsByPaneKey: nextAck,
              recentlyClosedAgentStatusTabIds: nextClosedTabs,
              recentlyRetiredAgentStatusPaneKeys: nextRetiredPaneKeys
            }
          }
          return {
            recentlyClosedAgentStatusTabIds: nextClosedTabs,
            recentlyRetiredAgentStatusPaneKeys: nextRetiredPaneKeys
          }
        }
        hadLive = liveKeys.length > 0

        const nextLive =
          liveKeys.length > 0 ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        for (const key of liveKeys) {
          delete nextLive[key]
        }
        const nextLaunchConfigs =
          launchConfigKeys.length > 0
            ? { ...s.agentLaunchConfigByPaneKey }
            : s.agentLaunchConfigByPaneKey
        for (const key of launchConfigKeys) {
          delete nextLaunchConfigs[key]
        }

        const nextRetained =
          retainedKeys.length > 0 ? { ...s.retainedAgentsByPaneKey } : s.retainedAgentsByPaneKey
        for (const key of retainedKeys) {
          delete nextRetained[key]
        }

        // Why: a suppressor is only consumed on a live→gone transition, so plant one only for live paneKeys and skip already-suppressed and completed-orphan keys — otherwise it leaks (mirrors dropAgentStatus).
        const suppressorAdds = liveKeys.filter(
          (k) => !completedOrphanKeySet.has(k) && !(k in s.retentionSuppressedPaneKeys)
        )
        let nextRetentionSuppressedPaneKeys = s.retentionSuppressedPaneKeys
        if (suppressorAdds.length > 0) {
          nextRetentionSuppressedPaneKeys = { ...s.retentionSuppressedPaneKeys }
          for (const key of suppressorAdds) {
            nextRetentionSuppressedPaneKeys[key] = true
          }
        }

        return {
          agentStatusByPaneKey: nextLive,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          retainedAgentsByPaneKey: nextRetained,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
          recentlyClosedAgentStatusTabIds: nextClosedTabs,
          recentlyRetiredAgentStatusPaneKeys: nextRetiredPaneKeys,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          // Why: mirrors removeAgentStatusByTabPrefix — only bump epochs when the live map changed; retained-only sweeps don't affect sort/freshness.
          agentStatusEpoch:
            hadLive || migrationUnsupported.changed ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: hadLive || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.dropByTabPrefix?.(tabIdPrefix)
      }
    },

    dropHibernatedAgentStatusPane: (worktreeId, paneKey, opts) => {
      let hadLive = false
      set((s) => {
        const liveEntry = s.agentStatusByPaneKey[paneKey]
        const hasLive = liveEntry !== undefined
        const hasRetained = paneKey in s.retainedAgentsByPaneKey
        const hasLaunchConfig = paneKey in s.agentLaunchConfigByPaneKey
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey === paneKey
        )
        const retainedEvidence = new Map<string, RetainedAgentEntry>()
        for (const retained of opts?.retainedCompletionEvidence ?? []) {
          if (
            retained.entry.paneKey === paneKey &&
            !liveEntry &&
            shouldReplaceRetainedWithLive(retainedEvidence.get(paneKey), retained)
          ) {
            retainedEvidence.set(paneKey, retained)
          }
        }
        if (
          liveEntry?.state === 'done' &&
          liveEntry.agentType !== undefined &&
          liveEntry.interrupted !== true
        ) {
          retainedEvidence.set(
            paneKey,
            retainedAgentEntryFromLive(s, worktreeId, liveEntry, liveEntry.agentType)
          )
        }
        const keepsCompletionEvidence = retainedEvidence.has(paneKey)
        let nextAck = s.acknowledgedAgentsByPaneKey
        if (!keepsCompletionEvidence && paneKey in nextAck) {
          nextAck = { ...nextAck }
          delete nextAck[paneKey]
        }
        if (
          !hasLive &&
          !hasRetained &&
          !hasLaunchConfig &&
          !migrationUnsupported.changed &&
          !keepsCompletionEvidence
        ) {
          if (nextAck !== s.acknowledgedAgentsByPaneKey) {
            return { acknowledgedAgentsByPaneKey: nextAck }
          }
          return s
        }
        hadLive = hasLive

        const nextLive = hasLive ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        if (hasLive) {
          delete nextLive[paneKey]
        }
        const nextLaunchConfigs = hasLaunchConfig
          ? { ...s.agentLaunchConfigByPaneKey }
          : s.agentLaunchConfigByPaneKey
        if (hasLaunchConfig) {
          delete nextLaunchConfigs[paneKey]
        }

        const nextRetained =
          hasRetained || keepsCompletionEvidence
            ? { ...s.retainedAgentsByPaneKey }
            : s.retainedAgentsByPaneKey
        if (hasRetained && !keepsCompletionEvidence) {
          delete nextRetained[paneKey]
        }
        for (const [key, retained] of retainedEvidence) {
          if (shouldReplaceRetainedWithLive(nextRetained[key], retained)) {
            nextRetained[key] = retained
          }
        }

        const needsSuppressor =
          hasLive && !keepsCompletionEvidence && !(paneKey in s.retentionSuppressedPaneKeys)

        return {
          agentStatusByPaneKey: nextLive,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          retainedAgentsByPaneKey: nextRetained,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          ...(needsSuppressor
            ? {
                retentionSuppressedPaneKeys: {
                  ...s.retentionSuppressedPaneKeys,
                  [paneKey]: true
                }
              }
            : {}),
          agentStatusEpoch:
            hasLive || migrationUnsupported.changed ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: hasLive || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
    },

    dropAgentStatusByWorktree: (worktreeId, opts) => {
      let hadLive = false
      set((s) => {
        const tabPrefixes = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
        const liveEntries = Object.entries(s.agentStatusByPaneKey).filter(
          ([paneKey, entry]) =>
            entry.worktreeId === worktreeId || paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes)
        )
        const liveKeys = liveEntries.map(([paneKey]) => paneKey)
        const liveKeySet = new Set(liveKeys)
        const launchConfigKeys = Object.keys(s.agentLaunchConfigByPaneKey).filter(
          (paneKey) => paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes) || liveKeySet.has(paneKey)
        )
        const retainedKeys = Object.entries(s.retainedAgentsByPaneKey)
          .filter(
            ([paneKey, retained]) =>
              retained.worktreeId === worktreeId || paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes)
          )
          .map(([paneKey]) => paneKey)
        const retainedKeySet = new Set(retainedKeys)
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) =>
            entry.worktreeId === worktreeId ||
            (entry.paneKey ? paneKeyMatchesAnyTabPrefix(entry.paneKey, tabPrefixes) : false)
        )
        const allowedPaneKeys = normalizePaneKeySet(opts?.sleepingPaneKeys)
        const preserveHibernatedEvidence =
          opts?.shutdownReason === 'auto-hibernate-completed-agent' &&
          allowedPaneKeys !== null &&
          allowedPaneKeys.size > 0
        const liveEntryByPaneKey = new Map(liveEntries)
        const retainedEvidence = new Map<string, RetainedAgentEntry>()
        if (preserveHibernatedEvidence) {
          for (const retained of opts?.retainedCompletionEvidence ?? []) {
            if (
              allowedPaneKeys.has(retained.entry.paneKey) &&
              !liveEntryByPaneKey.has(retained.entry.paneKey) &&
              shouldReplaceRetainedWithLive(retainedEvidence.get(retained.entry.paneKey), retained)
            ) {
              retainedEvidence.set(retained.entry.paneKey, retained)
            }
          }
          for (const [paneKey, entry] of liveEntries) {
            const agentType = entry.agentType
            if (
              allowedPaneKeys.has(paneKey) &&
              entry.state === 'done' &&
              agentType !== undefined &&
              entry.interrupted !== true
            ) {
              retainedEvidence.set(
                paneKey,
                retainedAgentEntryFromLive(s, worktreeId, entry, agentType)
              )
            }
          }
        }
        const retainedEvidenceKeys = new Set(retainedEvidence.keys())
        // See removeAgentStatus for ack-cleanup rationale; auto-hibernated completion evidence keeps its read state so a slept card doesn't turn bold again.
        let nextAck = s.acknowledgedAgentsByPaneKey
        const ackKeys = Object.keys(nextAck).filter(
          (k) =>
            !retainedEvidenceKeys.has(k) &&
            (paneKeyMatchesAnyTabPrefix(k, tabPrefixes) ||
              liveKeySet.has(k) ||
              retainedKeySet.has(k))
        )
        if (ackKeys.length > 0) {
          nextAck = { ...nextAck }
          for (const key of ackKeys) {
            delete nextAck[key]
          }
        }
        // Mirror dropAgentStatusByTabPrefix: when nothing live/retained changed, return just the ack delta (or s) to avoid full-state re-renders.
        if (
          liveKeys.length === 0 &&
          launchConfigKeys.length === 0 &&
          retainedKeys.length === 0 &&
          retainedEvidence.size === 0 &&
          !migrationUnsupported.changed
        ) {
          if (nextAck !== s.acknowledgedAgentsByPaneKey) {
            return { acknowledgedAgentsByPaneKey: nextAck }
          }
          return s
        }
        hadLive = liveKeys.length > 0

        const nextLive =
          liveKeys.length > 0 ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        for (const key of liveKeys) {
          delete nextLive[key]
        }
        const nextLaunchConfigs =
          launchConfigKeys.length > 0
            ? { ...s.agentLaunchConfigByPaneKey }
            : s.agentLaunchConfigByPaneKey
        for (const key of launchConfigKeys) {
          delete nextLaunchConfigs[key]
        }

        const nextRetained =
          retainedKeys.length > 0 || retainedEvidence.size > 0
            ? { ...s.retainedAgentsByPaneKey }
            : s.retainedAgentsByPaneKey
        for (const key of retainedKeys) {
          if (!retainedEvidenceKeys.has(key)) {
            delete nextRetained[key]
          }
        }
        for (const [paneKey, retained] of retainedEvidence) {
          if (shouldReplaceRetainedWithLive(nextRetained[paneKey], retained)) {
            nextRetained[paneKey] = retained
          }
        }

        // Why: suppress live rows on teardown, but skip auto-hibernated `done` rows — they become retained evidence a suppressor would erase next sync.
        const suppressorAdds = liveKeys.filter(
          (k) => !retainedEvidenceKeys.has(k) && !(k in s.retentionSuppressedPaneKeys)
        )
        let nextRetentionSuppressedPaneKeys = s.retentionSuppressedPaneKeys
        if (suppressorAdds.length > 0) {
          nextRetentionSuppressedPaneKeys = { ...s.retentionSuppressedPaneKeys }
          for (const key of suppressorAdds) {
            nextRetentionSuppressedPaneKeys[key] = true
          }
        }

        return {
          agentStatusByPaneKey: nextLive,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          retainedAgentsByPaneKey: nextRetained,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          agentStatusEpoch:
            hadLive || migrationUnsupported.changed ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: hadLive || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
    },

    captureSleepingAgentSessionsByWorktree: (worktreeId, paneKeys) => {
      set((s) => {
        const records = collectSleepingAgentSessionRecordsForWorktree(s, worktreeId, {
          paneKeys,
          captureMode: 'manual-worktree-sleep'
        })
        const replaced = removeSleepingRecordsReplacedByManualWorktreeSleep(
          s.sleepingAgentSessionsByPaneKey,
          worktreeId,
          paneKeys
        )
        const next: Record<string, SleepingAgentSessionRecord> = { ...replaced.records }
        let changed = replaced.changed

        for (const record of Object.values(records)) {
          if (next[record.paneKey] !== record) {
            next[record.paneKey] = record
            changed = true
          }
        }

        return changed ? { sleepingAgentSessionsByPaneKey: next } : s
      })
    },

    captureAllSleepingAgentSessions: (mode) => {
      // Why: periodic checkpoints and quit flushes both persist provider ids, but only a confirmed quit may claim quit precedence.
      set((s) => {
        const capturedAt = Date.now()
        const origin = mode === 'quit' ? ('quit' as const) : ('live' as const)
        const next: Record<string, SleepingAgentSessionRecord> = {
          ...s.sleepingAgentSessionsByPaneKey
        }
        let changed = false
        for (const entry of Object.values(s.agentStatusByPaneKey)) {
          if (entry.state === 'done') {
            const existing = next[entry.paneKey]
            if (!isCompletedPiWithLiveRecoveryRecord(entry, existing)) {
              continue
            }
            if (mode === 'periodic') {
              continue
            }
            const record = { ...existing, capturedAt, origin }
            if (!sleepingRecordsEquivalentIgnoringCaptureTime(existing, record)) {
              next[entry.paneKey] = record
              changed = true
            }
            continue
          }
          const worktreeId = entry.worktreeId ?? findAgentPaneWorktreeId(s, entry.paneKey)
          if (!worktreeId) {
            continue
          }
          const record = sleepingRecordFromEntry({
            state: s,
            entry,
            worktreeId,
            capturedAt,
            launchConfig: getLaunchConfigForEntry(s, entry),
            origin
          })
          const existing = next[entry.paneKey]
          // Why: a periodic timer must not downgrade a confirmed-quit shutdown snapshot; a live hook event supersedes it elsewhere.
          if (
            mode === 'periodic' &&
            existing?.origin === 'quit' &&
            record &&
            recoveryRecordTargetsSameSession(existing, record)
          ) {
            continue
          }
          if (record && !sleepingRecordsEquivalentIgnoringCaptureTime(existing, record)) {
            next[record.paneKey] = record
            changed = true
          }
        }
        return changed ? { sleepingAgentSessionsByPaneKey: next } : s
      })
    },

    clearSleepingAgentSession: (paneKey) => clearSleepingAgentSessionsByPaneKey([paneKey]),
    clearSleepingAgentSessionsByPaneKey,

    clearSleepingAgentSessionsByWorktree: (worktreeId) => {
      set((s) => {
        let changed = false
        const next: Record<string, SleepingAgentSessionRecord> = {}
        const launchConfigKeysToRemove: string[] = []
        for (const [paneKey, record] of Object.entries(s.sleepingAgentSessionsByPaneKey)) {
          if (record.worktreeId === worktreeId) {
            changed = true
            launchConfigKeysToRemove.push(paneKey)
            continue
          }
          next[paneKey] = record
        }
        const nextLaunchConfigs =
          launchConfigKeysToRemove.length > 0 ? { ...s.agentLaunchConfigByPaneKey } : null
        if (nextLaunchConfigs) {
          for (const paneKey of launchConfigKeysToRemove) {
            delete nextLaunchConfigs[paneKey]
          }
        }
        return changed
          ? {
              sleepingAgentSessionsByPaneKey: next,
              ...(nextLaunchConfigs ? { agentLaunchConfigByPaneKey: nextLaunchConfigs } : {})
            }
          : s
      })
    },

    pruneSleepingAgentSessions: (validWorktreeIds) => {
      set((s) => {
        let changed = false
        const next: Record<string, SleepingAgentSessionRecord> = {}
        const launchConfigKeysToRemove: string[] = []
        for (const [paneKey, record] of Object.entries(s.sleepingAgentSessionsByPaneKey)) {
          if (!validWorktreeIds.has(record.worktreeId)) {
            changed = true
            launchConfigKeysToRemove.push(paneKey)
            continue
          }
          next[paneKey] = record
        }
        const nextLaunchConfigs =
          launchConfigKeysToRemove.length > 0 ? { ...s.agentLaunchConfigByPaneKey } : null
        if (nextLaunchConfigs) {
          for (const paneKey of launchConfigKeysToRemove) {
            delete nextLaunchConfigs[paneKey]
          }
        }
        return changed
          ? {
              sleepingAgentSessionsByPaneKey: next,
              ...(nextLaunchConfigs ? { agentLaunchConfigByPaneKey: nextLaunchConfigs } : {})
            }
          : s
      })
    },

    retainAgents: (entries) => {
      // Why: retained entries are a pure read-overlay (no epoch bump needed); batch into one set so multi-agent disappearance is atomic.
      if (entries.length === 0) {
        return
      }
      set((s) => {
        // Why: skip reallocation when every entry is already present by reference — consumers select on map identity, so a spurious realloc forces re-renders.
        let changed = false
        for (const retained of entries) {
          if (s.retainedAgentsByPaneKey[retained.entry.paneKey] !== retained) {
            changed = true
            break
          }
        }
        if (!changed) {
          return s
        }
        const next = { ...s.retainedAgentsByPaneKey }
        for (const retained of entries) {
          const runtimeOrchestration = s.runtimeAgentOrchestrationByPaneKey[retained.entry.paneKey]
          const mergedOrchestration = runtimeOrchestration
            ? mergeCurrentOrchestrationContext(retained.entry.orchestration, runtimeOrchestration)
            : retained.entry.orchestration
          const entry =
            mergedOrchestration !== retained.entry.orchestration
              ? { ...retained.entry, orchestration: mergedOrchestration }
              : retained.entry
          // INVARIANT: map key equals retained.entry.paneKey, so callers look up retained rows by the same paneKey as agentStatusByPaneKey.
          next[retained.entry.paneKey] =
            entry === retained.entry ? retained : { ...retained, entry }
        }
        // Why: cap the map so a long multi-agent session can't leak the renderer heap (retainAgents is the only growth path); evicts oldest-retained first.
        return { retainedAgentsByPaneKey: capRetainedAgents(next) }
      })
    },

    dismissRetainedAgent: (paneKey) => {
      // Why: no epoch bump (mirrors retainAgents) — retained rows are a pure read-overlay that don't affect smart-sort; selectors re-render on map identity.
      set((s) => {
        if (!(paneKey in s.retainedAgentsByPaneKey)) {
          return s
        }
        const next = { ...s.retainedAgentsByPaneKey }
        delete next[paneKey]
        // Why: mirror dropAgentStatus — plant a one-shot suppressor only when a live entry coexists, so the retention sync doesn't resurrect this dismissed row (gate on hasLive, else it leaks).
        const hasLive = paneKey in s.agentStatusByPaneKey
        if (!hasLive || paneKey in s.retentionSuppressedPaneKeys) {
          return { retainedAgentsByPaneKey: next }
        }
        return {
          retainedAgentsByPaneKey: next,
          retentionSuppressedPaneKeys: {
            ...s.retentionSuppressedPaneKeys,
            [paneKey]: true
          }
        }
      })
    },

    dismissRetainedAgentsByWorktree: (worktreeId) => {
      // Why: collect removed paneKeys inside set, then fan out window.api drop so the on-disk cache doesn't resurrect the dismissed rows on next launch.
      const dismissedPaneKeys: string[] = []
      set((s) => {
        let changed = false
        const next: Record<string, RetainedAgentEntry> = {}
        // Why: mirror dismissRetainedAgent — plant a suppressor only for dismissed paneKeys that also have a live entry, else the next live→gone transition re-retains the row (a retained-only suppressor leaks).
        const toSuppress: string[] = []
        for (const [key, ra] of Object.entries(s.retainedAgentsByPaneKey)) {
          if (ra.worktreeId === worktreeId) {
            changed = true
            dismissedPaneKeys.push(key)
            if (key in s.agentStatusByPaneKey && !(key in s.retentionSuppressedPaneKeys)) {
              toSuppress.push(key)
            }
            continue
          }
          next[key] = ra
        }
        if (!changed) {
          return s
        }
        if (toSuppress.length === 0) {
          return { retainedAgentsByPaneKey: next }
        }
        const nextSuppressed = { ...s.retentionSuppressedPaneKeys }
        for (const key of toSuppress) {
          nextSuppressed[key] = true
        }
        return {
          retainedAgentsByPaneKey: next,
          retentionSuppressedPaneKeys: nextSuppressed
        }
      })
      if (typeof window !== 'undefined') {
        for (const paneKey of dismissedPaneKeys) {
          window.api?.agentStatus?.drop?.(paneKey)
        }
      }
    },

    pruneRetainedAgents: (validWorktreeIds) => {
      // Why: intentionally leaves retentionSuppressedPaneKeys — paneKeys are minted fresh on worktree re-create, so stale suppressors can never match a future live entry.
      set((s) => {
        let changed = false
        const next: Record<string, RetainedAgentEntry> = {}
        for (const [key, ra] of Object.entries(s.retainedAgentsByPaneKey)) {
          if (!validWorktreeIds.has(ra.worktreeId)) {
            changed = true
            continue
          }
          next[key] = ra
        }
        return changed ? { retainedAgentsByPaneKey: next } : s
      })
    },

    clearRetentionSuppressedPaneKeys: (paneKeys) => {
      set((s) => {
        let changed = false
        const next = { ...s.retentionSuppressedPaneKeys }
        for (const paneKey of paneKeys) {
          if (!(paneKey in next)) {
            continue
          }
          delete next[paneKey]
          changed = true
        }
        return changed ? { retentionSuppressedPaneKeys: next } : s
      })
    }
  }
}
