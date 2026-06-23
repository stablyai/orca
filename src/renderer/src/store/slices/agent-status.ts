/* eslint-disable max-lines -- Why: the agent-status slice co-locates live map, retained snapshots, retention-suppression, and tab-prefix sweep so the teardown contract stays readable end-to-end. Splitting across files would scatter the drop/remove/retain interactions that must stay in lockstep. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  AGENT_STATE_HISTORY_MAX,
  type AgentStateHistoryEntry,
  type AgentStatusEntry,
  type AgentStatusOrchestrationContext,
  type AgentType,
  type MigrationUnsupportedPtyEntry,
  type ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import {
  getAgentResumeArgv,
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from '../../../../shared/agent-status-identity'
import type { TerminalTab } from '../../../../shared/types'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { createFreshnessScheduler } from './agent-status-freshness-scheduler'

/** Snapshot of a finished (or vanished) agent status entry, kept around so
 *  the dashboard + sidebar hover can continue showing the completion until the
 *  user acknowledges it by clicking the worktree. The `worktreeId` is stamped
 *  at retention time so we know where the row belongs even after the tab/pty
 *  it came from has gone away. */
export type RetainedAgentEntry = {
  entry: AgentStatusEntry
  worktreeId: string
  /** Snapshot of the tab the agent lived in at retention time. We keep the
   *  full record (not just an id) because the tab may be gone from
   *  `tabsByWorktree` by the time the retained row is rendered. */
  tab: TerminalTab
  agentType: AgentType
  startedAt: number
}

export type AgentStatusWorktreeShutdownReason =
  | 'manual-sleep'
  | 'remove-worktree'
  | 'auto-hibernate-completed-agent'

type DropAgentStatusByWorktreeOptions = {
  shutdownReason?: AgentStatusWorktreeShutdownReason
  sleepingPaneKeys?: readonly string[] | ReadonlySet<string>
  retainedCompletionEvidence?: readonly RetainedAgentEntry[]
}

type DropHibernatedAgentPaneOptions = {
  retainedCompletionEvidence?: readonly RetainedAgentEntry[]
}

type AgentLaunchConfigRegistrationMetadata = {
  agentType?: AgentType
  launchToken?: string
  tabId?: string
  leafId?: string
  terminalHandle?: string
  providerSession?: AgentProviderSessionMetadata
}

type AgentLaunchConfigRegistryEntry = {
  launchConfig: SleepingAgentLaunchConfig
  registeredAt: number
  identity: AgentLaunchConfigRegistrationMetadata
}

export type AgentStatusSlice = {
  /** Explicit agent status entries keyed by `${tabId}:${leafId}` composite.
   *  Real-time only — lives in renderer memory, not persisted to disk. */
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  /** Main-synced dispatch metadata for live terminal panes that may only have
   *  title-derived status in the renderer. */
  runtimeAgentOrchestrationByPaneKey: Record<string, AgentStatusOrchestrationContext>
  /** PTYs that still report legacy numeric pane keys but have registry-backed
   *  UUID pane proof. Stored separately from normal hook-reported status. */
  migrationUnsupportedByPtyId: Record<string, MigrationUnsupportedPtyEntry>
  /** Monotonic tick that advances when agent-status freshness boundaries pass. */
  agentStatusEpoch: number

  /** Retained "done" entries — snapshots of agents that have disappeared from
   *  `agentStatusByPaneKey`. Keyed by paneKey so re-appearance of the same pane
   *  overwrites the snapshot. Shared between the dashboard and the sidebar
   *  agent-status hover so the two surfaces display identical rows. */
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>

  /** Durable agent sessions captured when a workspace sleeps. These are not
   *  live status rows; they power the one-click CLI resume action on wake. */
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>

  /** Ephemeral launch snapshots keyed by concrete pane. Hook payloads do not
   *  carry Orca launch settings, so the renderer supplies them from startup. */
  agentLaunchConfigByPaneKey: Record<string, AgentLaunchConfigRegistryEntry>

  /** Pane keys explicitly torn down (pane close, tab close, PTY exit, manual
   *  dismissal) and therefore forbidden from being re-retained on their next
   *  disappearance. Consumed by the retention sync as a one-shot suppressor. */
  retentionSuppressedPaneKeys: Record<string, true>

  /** Terminal tabs explicitly closed in this renderer session. Used only to
   *  drop late in-flight IPC statuses and stale main-cache replays. */
  recentlyClosedAgentStatusTabIds: Record<string, true>

  /** Update or insert an agent status entry from a status payload. */
  setAgentStatus: (
    paneKey: string,
    payload: ParsedAgentStatusPayload & { orchestration?: AgentStatusOrchestrationContext },
    terminalTitle?: string,
    timing?: { updatedAt?: number; stateStartedAt?: number },
    routing?: { tabId?: string; worktreeId?: string; terminalHandle?: string },
    metadata?: {
      providerSession?: AgentProviderSessionMetadata
      launchConfig?: SleepingAgentLaunchConfig
      launchToken?: string
    }
  ) => void

  registerAgentLaunchConfig: (
    paneKey: string,
    launchConfig: SleepingAgentLaunchConfig,
    metadata?: AgentLaunchConfigRegistrationMetadata
  ) => void
  getAgentLaunchConfigForStatusEntry: (
    entry: AgentStatusEntry
  ) => SleepingAgentLaunchConfig | undefined
  clearAgentLaunchConfig: (paneKey: string) => void

  setRuntimeAgentOrchestrationByPaneKey: (
    entries: Record<string, AgentStatusOrchestrationContext>
  ) => void

  setMigrationUnsupportedPty: (entry: MigrationUnsupportedPtyEntry) => void
  clearMigrationUnsupportedPty: (ptyId: string) => void

  /** Remove a single entry (e.g., when a pane's terminal exits). */
  removeAgentStatus: (paneKey: string) => void

  /** Remove all entries whose paneKey starts with the given prefix.
   *  Used when a tab is closed — same prefix-sweep as cacheTimerByKey cleanup. */
  removeAgentStatusByTabPrefix: (tabIdPrefix: string) => void

  /** Remove a single entry AND suppress re-retention on its next disappearance.
   *  Used for USER-INITIATED teardown — the dashboard/hover X button, and
   *  pane close — where the user is telling us "I'm done with this row". */
  dropAgentStatus: (paneKey: string) => void

  /** Remove all entries under a tab AND suppress re-retention for each.
   *  Used on tab close — the user is tearing down the whole tab, so any
   *  remaining agent rows (live or retained) must not reappear. */
  dropAgentStatusByTabPrefix: (tabIdPrefix: string) => void

  /** Remove one automatically hibernated completed-agent pane while preserving
   *  sibling live/retained rows in the same worktree. */
  dropHibernatedAgentStatusPane: (
    worktreeId: string,
    paneKey: string,
    opts?: DropHibernatedAgentPaneOptions
  ) => void

  /** Remove all entries for a worktree AND suppress re-retention for live rows.
   *  Used on worktree sleep/remove — the whole worktree surface is folding, so
   *  retained rows must drop even if their original tab is no longer present.
   *
   *  Live entries are swept by tab prefix and by main-stamped worktree
   *  attribution so worker rows that arrive before their tab exists do not
   *  survive sleep/remove. */
  dropAgentStatusByWorktree: (worktreeId: string, opts?: DropAgentStatusByWorktreeOptions) => void

  captureSleepingAgentSessionsByWorktree: (worktreeId: string, paneKeys?: string[]) => void
  /** Capture resumable agent sessions across every worktree. Called from the
   *  quit flush so provider session ids survive an app restart. */
  captureAllSleepingAgentSessions: () => void
  clearSleepingAgentSession: (paneKey: string) => void
  clearSleepingAgentSessionsByWorktree: (worktreeId: string) => void
  pruneSleepingAgentSessions: (validWorktreeIds: Set<string>) => void

  /** Retain agent snapshots (called by the top-level retention sync effect).
   *  Accepts an array so multiple agents disappearing in the same frame
   *  produce a single set(...) — avoids intermediate states visible
   *  mid-loop to consumers. */
  retainAgents: (entries: RetainedAgentEntry[]) => void

  /** Dismiss a retained entry by its paneKey. */
  dismissRetainedAgent: (paneKey: string) => void

  /** Dismiss all retained entries belonging to a worktree. */
  dismissRetainedAgentsByWorktree: (worktreeId: string) => void

  /** Prune retained entries whose worktreeId is not in the given set. */
  pruneRetainedAgents: (validWorktreeIds: Set<string>) => void

  /** Clear one-shot teardown suppressors after the retention sync observes
   *  that disappearance and decides not to retain the row. */
  clearRetentionSuppressedPaneKeys: (paneKeys: string[]) => void
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

function getLeafIdFromPaneKey(paneKey: string): string | null {
  const separator = paneKey.indexOf(':')
  if (separator <= 0 || separator !== paneKey.lastIndexOf(':')) {
    return null
  }
  const leafId = paneKey.slice(separator + 1)
  return leafId.length > 0 ? leafId : null
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
  // Why: hibernated completions are intentional worktree-owned records; wake
  // treats originless completed records as ambiguous legacy captures.
  const origin: SleepingAgentSessionRecord['origin'] | undefined = isWorktreeOwnedCapture
    ? 'worktree-sleep'
    : undefined
  const tabPrefixes = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
  const records: Record<string, SleepingAgentSessionRecord> = {}

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
    existing.providerSession.key === next.providerSession.key &&
    existing.providerSession.id === next.providerSession.id &&
    launchConfigsEqual(existing.launchConfig, next.launchConfig)
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

function providerSessionsEqual(
  a: AgentProviderSessionMetadata | undefined,
  b: AgentProviderSessionMetadata | undefined
): boolean {
  if (a === undefined || b === undefined) {
    return a === b
  }
  return a.key === b.key && a.id === b.id
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
    providerSessionsEqual(a.identity.providerSession, b.identity.providerSession)
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
  if (identity.providerSession !== undefined) {
    return providerSessionsEqual(identity.providerSession, args.providerSession)
  }
  if (
    identity.launchToken !== undefined &&
    (args.launchToken === undefined || identity.launchToken !== args.launchToken)
  ) {
    return false
  }
  if (identity.launchToken !== undefined) {
    return true
  }
  if (identity.terminalHandle !== undefined) {
    return true
  }
  if (args.existingProviderSession && args.providerSession) {
    return providerSessionsEqual(args.existingProviderSession, args.providerSession)
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
    providerSessionsEqual(sleepingRecord.providerSession, entry.providerSession)
    ? sleepingRecord.launchConfig
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

export const createAgentStatusSlice: StateCreator<AppState, [], [], AgentStatusSlice> = (
  set,
  get
) => {
  // Why: the freshness scheduler is intentionally process-lifetime-scoped —
  // no dispose path — because it matches the store's own lifetime model
  // (the zustand store is a module-level singleton that lives until process
  // exit). Adding a teardown hook would require a store-dispose lifecycle
  // that does not exist anywhere else in the codebase.
  const freshness = createFreshnessScheduler({
    getEntries: () => Object.values(get().agentStatusByPaneKey),
    bumpEpochs: () => {
      // Why: freshness is time-based, not event-based. Advancing these epochs
      // at the exact stale boundary forces all freshness-aware selectors to
      // recompute — and re-sorts WorktreeList — even when no new PTY output
      // arrives. sortEpoch must bump in lockstep with agentStatusEpoch because
      // a stale transition can legitimately change worktree ordering.
      set((s) => ({
        agentStatusEpoch: s.agentStatusEpoch + 1,
        sortEpoch: s.sortEpoch + 1
      }))
    }
  })

  return {
    agentStatusByPaneKey: {},
    runtimeAgentOrchestrationByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    agentStatusEpoch: 0,
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    retentionSuppressedPaneKeys: {},
    recentlyClosedAgentStatusTabIds: {},

    setRuntimeAgentOrchestrationByPaneKey: (entries) => {
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
              nextLive[paneKey] = { ...liveEntry, orchestration: merged }
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

    setAgentStatus: (paneKey, payload, terminalTitle, timing, routing, metadata) => {
      const updatedAt = timing?.updatedAt ?? Date.now()
      if (
        // Why: a closed terminal tab is no longer a valid destination for hook
        // replays or late status events, even if main still receives them.
        isRecentlyClosedAgentStatusTab(
          get().recentlyClosedAgentStatusTabIds,
          getTabIdFromPaneKey(paneKey)
        )
      ) {
        return
      }
      let completionRefreshWorktreeId: string | null = null
      let suppressedInheritedTerminalStatus = false
      set((s) => {
        const existing = s.agentStatusByPaneKey[paneKey]
        // Why: snapshots and live pushes share receivedAt from the same main-side
        // lastStatusByPaneKey.set, so equal timestamps carry identical data. Strict <
        // preserves live-after-live updates that land in the same millisecond.
        if (existing && updatedAt < existing.updatedAt) {
          return s
        }
        // Why: terminalTitle is identity-like — it labels the pane itself, not
        // the current turn's activity. Preserve the prior value when a ping
        // omits it so the pane label does not flicker out between hook events.
        // Unlike the tool/prompt/assistant fields below (which legitimately
        // clear on a fresh turn), a missing title means "no update", not "the
        // pane has no title any more".
        const effectiveTitle = terminalTitle ?? existing?.terminalTitle

        // Why: build up a rolling log of state transitions so the dashboard can
        // render activity blocks showing what the agent has been doing. Only push
        // when the state actually changes to avoid duplicate entries from prompt-
        // only updates within the same state.
        let history: AgentStateHistoryEntry[] = existing?.stateHistory ?? []
        if (existing && existing.state !== payload.state) {
          history = [
            ...history,
            {
              state: existing.state,
              prompt: existing.prompt,
              // Why: use stateStartedAt (not updatedAt) so the history row
              // reflects when the state was first reported, not the most
              // recent within-state ping (tool/prompt updates refresh
              // updatedAt but not stateStartedAt).
              startedAt: existing.stateStartedAt,
              // Why: preserve the interrupt flag on the historical `done` entry
              // so activity-block views can render past cancellations as such.
              interrupted: existing.interrupted
            }
          ]
          if (history.length > AGENT_STATE_HISTORY_MAX) {
            history = history.slice(history.length - AGENT_STATE_HISTORY_MAX)
          }
        }

        // Why: prefer main's authoritative stateStartedAt when provided — main's
        // attachStatusTiming preserves it across same-state pings (server.ts) and
        // persists it across restart. Fall back to existing.stateStartedAt only when
        // main did not send timing (legacy callers / OSC fallback path), and to
        // updatedAt for a brand-new pane.
        const stateStartedAt =
          timing?.stateStartedAt ??
          (existing && existing.state === payload.state ? existing.stateStartedAt : updatedAt)
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

        // Why: tool/assistant fields come pre-merged from the main-process
        // cache (see `resolveToolState` in server.ts), so the payload always
        // carries the authoritative current snapshot — including clears on a
        // fresh turn. Writing through directly (no existing fallback) is what
        // lets a `UserPromptSubmit` reset clear stale tool lines in the UI.
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
        const canReuseExistingIdentity =
          existing?.agentType === identity.agentType &&
          !isAgentCompletionState(existing.state) &&
          !isAgentCompletionState(payload.state)
        const providerSession =
          metadata?.providerSession ??
          (canReuseExistingIdentity ? existing.providerSession : undefined)
        const existingProviderSession = canReuseExistingIdentity
          ? existing.providerSession
          : undefined
        const providerSessionChanged =
          Boolean(metadata?.providerSession && existingProviderSession) &&
          (metadata?.providerSession?.key !== existingProviderSession?.key ||
            metadata?.providerSession?.id !== existingProviderSession?.id)
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
        const matchedSleepingLaunchConfig =
          payload.state !== 'done' &&
          existingSleepingRecord?.launchConfig &&
          existingSleepingRecord.agent === identity.agentType &&
          providerSession &&
          providerSessionsEqual(existingSleepingRecord.providerSession, providerSession)
            ? existingSleepingRecord.launchConfig
            : undefined
        // Why: pane keys can be reused after a manually-started agent replaces
        // an Orca-launched one. Once the provider session changes, the old
        // pane-key launch registry must not bleed options into the new session.
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
          paneKey,
          terminalHandle: statusTerminalHandle,
          worktreeId:
            routing?.worktreeId ??
            existing?.worktreeId ??
            findAgentPaneWorktreeId(s, paneKey) ??
            undefined,
          tabId: statusTabId,
          terminalTitle: effectiveTitle,
          stateHistory: history,
          toolName: payload.toolName,
          toolInput: payload.toolInput,
          lastAssistantMessage: payload.lastAssistantMessage,
          // Why: reused panes may start non-orchestrated work after runtime
          // metadata expires. Only final done rows keep the previous lineage
          // fallback so completed children stay grouped.
          orchestration,
          ...(providerSession ? { providerSession } : {}),
          // Why: interrupted lives on `done` only. parseAgentStatusPayload
          // already clamps it to `undefined` for non-done states, so writing
          // the field through directly preserves truth for done and resets
          // it when a new turn starts (working → Stop reprices it).
          interrupted: payload.interrupted
        }
        if (
          isAgentCompletionState(entry.state) &&
          existing !== undefined &&
          !isAgentCompletionState(existing.state)
        ) {
          completionRefreshWorktreeId = entry.worktreeId ?? findAgentPaneWorktreeId(s, paneKey)
        }
        // Why: broad freshness-aware subscribers only need a global tick when
        // an entry appears, changes state, crosses stale->fresh, or receives
        // a same-state `done` update that may carry the final assistant
        // message for retained rows. Same-state working prompt/tool pings
        // still update agentStatusByPaneKey for the owning row, but they must
        // not fan out through dashboard/sidebar aggregate work across every
        // card. Sort-relevant inputs are:
        //   1. `state` transitions — smart-sort class is a function of state.
        //   2. Freshness transitions (stale → fresh) — `resolveAttention` in
        //      smart-attention.ts filters entries through
        //      `isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)`
        //      (30-min TTL). A stale entry that refreshes with the SAME state
        //      goes from "not contributing" (Class 4) to driving a higher
        //      class — order must update. Snapshot hydration can pass an older
        //      updatedAt; in that case the entry is still stored with its true
        //      age, and selectors will immediately decay it if it is already
        //      stale.
        const wasFresh =
          !!existing && isExplicitAgentStatusFresh(existing, updatedAt, AGENT_STATUS_STALE_AFTER_MS)
        const sortRelevantChange = !existing || existing.state !== payload.state || !wasFresh
        const doneRetentionFieldsChanged =
          existing?.state === 'done' &&
          entry.state === 'done' &&
          (entry.prompt !== existing.prompt ||
            entry.updatedAt !== existing.updatedAt ||
            entry.stateStartedAt !== existing.stateStartedAt ||
            entry.agentType !== existing.agentType ||
            entry.terminalTitle !== existing.terminalTitle ||
            entry.toolName !== existing.toolName ||
            entry.toolInput !== existing.toolInput ||
            entry.lastAssistantMessage !== existing.lastAssistantMessage ||
            entry.orchestration !== existing.orchestration ||
            entry.providerSession !== existing.providerSession ||
            entry.interrupted !== existing.interrupted)
        const retentionRelevantChange = sortRelevantChange || doneRetentionFieldsChanged
        // Why: a new status event means the agent is live again — lift any
        // one-shot retention suppressor so the row can be retained normally
        // on its next disappearance. setAgentStatus fires on every PTY status
        // update (high frequency), so only clone retentionSuppressedPaneKeys
        // when there is actually a suppressor to remove — otherwise every
        // status ping would churn that map reference and force spurious
        // re-renders in any subscriber selecting on it.
        const hasSuppressor = paneKey in s.retentionSuppressedPaneKeys
        let nextRetentionSuppressedPaneKeys = s.retentionSuppressedPaneKeys
        if (hasSuppressor) {
          nextRetentionSuppressedPaneKeys = { ...s.retentionSuppressedPaneKeys }
          delete nextRetentionSuppressedPaneKeys[paneKey]
        }
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey === paneKey
        )
        const liveRecoveryWorktreeId =
          entry.state === 'done'
            ? null
            : (entry.worktreeId ?? findAgentPaneWorktreeId(s, entry.paneKey))
        const liveRecoveryRecord = liveRecoveryWorktreeId
          ? sleepingRecordFromEntry({
              state: s,
              entry,
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
          !providerSessionsEqual(registryEntry.identity.providerSession, providerSession)
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
        // Why: launch tokens can remain in a shell after an Orca-started TUI exits;
        // once the original session is done they must no longer authorize config reuse.
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
        return {
          agentStatusByPaneKey: { ...s.agentStatusByPaneKey, [paneKey]: entry },
          sleepingAgentSessionsByPaneKey: nextSleepingAgentSessions,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
          agentStatusEpoch:
            retentionRelevantChange || migrationUnsupported.changed
              ? s.agentStatusEpoch + 1
              : s.agentStatusEpoch,
          sortEpoch:
            sortRelevantChange || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (suppressedInheritedTerminalStatus) {
        return
      }
      get().setGeneratedTabTitleFromAgentPrompt(paneKey, payload.prompt)
      // Why: schedule after set completes so the timer reads the updated map.
      // queueMicrotask avoids re-entry into the zustand store during set.
      queueMicrotask(() => freshness.schedule())
      if (completionRefreshWorktreeId) {
        const worktreeId = completionRefreshWorktreeId
        // Why: agents can create a PR via `gh pr create`, bypassing Orca's
        // create-PR flow and leaving a fresh "no PR" cache entry in place.
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
        // Why: acknowledgedAgentsByPaneKey is written per user-ack but owned
        // lifecycle-wise by the pane — drop the ack entry in lockstep with the
        // live-map entry so closed panes don't leave stale ack timestamps that
        // could silently suppress "unvisited" signals on future paneKey
        // collisions.
        let nextAck = s.acknowledgedAgentsByPaneKey
        if (paneKey in nextAck) {
          nextAck = { ...nextAck }
          delete nextAck[paneKey]
        }
        // Why: bump sortEpoch in lockstep with agentStatusEpoch — removing an
        // agent can legitimately change worktree sort order, same rationale
        // as setAgentStatus.
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
        // Why: bump sortEpoch in lockstep with agentStatusEpoch — removing
        // agents can legitimately change worktree sort order, same rationale
        // as setAgentStatus. The pre-check guards against spurious bumps when
        // no keys matched the prefix.
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

    dropAgentStatus: (paneKey) => {
      // Why: single sync read — zustand set is synchronous, so the value we
      // observe inside the set callback is the same one we would re-read via
      // get() immediately after. Capture it once from inside the callback
      // rather than double-reading the store before and during set.
      let liveExisted = false
      set((s) => {
        const hasLive = paneKey in s.agentStatusByPaneKey
        liveExisted = hasLive
        const hasRetained = paneKey in s.retainedAgentsByPaneKey
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey === paneKey
        )
        // See removeAgentStatus for rationale on ack cleanup. Apply this
        // regardless of live/retained presence — the ack entry is owned by
        // the pane lifecycle independently of live/retained state.
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
        // Why: bail when there is genuinely nothing to do. The old guard
        // `!hasLive && !hasRetained && alreadySuppressed` leaked a phantom
        // suppressor write in the `!hasLive && !hasRetained && !alreadySuppressed`
        // case. With the hasLive-gated suppressor below, a no-op drop on a
        // paneKey with no live and no retained entry truly has nothing to
        // change, so short-circuit here — but still flush a pending ack
        // cleanup or launch-config cleanup if one is present.
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

        // Why: explicit teardown means "the user is done with this row", so
        // the next retention sync must not resurrect it from the previous frame.
        //
        // Why same-frame race is acceptable: if dropAgentStatus fires in the
        // same React frame as setAgentStatus, before useRetainedAgentsSync's
        // prevAgentsRef has captured the live entry, the planted suppressor
        // may never be consumed by a live→gone transition and would persist.
        // In practice suppressors are bounded by user-dismissed paneKeys (a
        // small set), so the leak is pragmatically inert — accepting it is
        // cheaper than threading frame-level ordering guarantees through the
        // retention sync.
        //
        // Why gate on hasLive: the suppressor is a one-shot flag consumed by
        // `collectRetainedAgentsOnDisappear` (useRetainedAgents.ts), which
        // iterates the PREVIOUS render's LIVE agents to decide what to
        // retain. If we dismiss a retained-only row (no live entry at drop
        // time), no live→gone transition will ever fire for this paneKey, so
        // the suppressor would never be consumed and would leak indefinitely
        // — only clearing if the same paneKey later became live again via
        // setAgentStatus. A retained-only dismissal just needs the retained
        // entry removed; there is no live-agent resurrection risk to guard
        // against. Only spread retentionSuppressedPaneKeys when hasLive.
        //
        // Why the `!(paneKey in s.retentionSuppressedPaneKeys)` check: if a
        // suppressor is already present, re-spreading produces a new object
        // reference with identical contents and spuriously re-renders any
        // subscriber selecting on retentionSuppressedPaneKeys. Mirror the
        // guard used in setAgentStatus.
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
          // Why: mirrors removeAgentStatus — dropping a live working/blocked
          // agent changes its contribution to the worktree sort score, so the
          // sidebar smart-sort must recompute. Without this bump, a user-
          // initiated dismissal from the inline agents list would leave the
          // sidebar ordering stale until some unrelated event repaired it.
          sortEpoch: hasLive || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      // Why: freshness.schedule only matters when the live map changed —
      // retained-only and no-op drops don't touch it. Gate on the live
      // presence observed inside set() so a noop drop on a paneKey with no
      // live and no retained entry (or a retained-only dismissal) skips the
      // microtask.
      if (liveExisted) {
        queueMicrotask(() => freshness.schedule())
      }
      // Why: propagate the dismissal to the main-process hook cache so the
      // on-disk last-status file evicts this paneKey on the next debounced
      // write. Without this, the main process would re-hydrate the dismissed
      // entry on the next launch and the row would re-appear. Fire-and-forget.
      // Why: the typeof window guard keeps the slice usable from the
      // node test environment, where window is undefined.
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.drop?.(paneKey)
      }
    },

    dropAgentStatusByTabPrefix: (tabIdPrefix) => {
      const prefix = `${tabIdPrefix}:`
      let hadLive = false
      set((s) => {
        const liveKeys = Object.keys(s.agentStatusByPaneKey).filter((k) => k.startsWith(prefix))
        const launchConfigKeys = Object.keys(s.agentLaunchConfigByPaneKey).filter((k) =>
          k.startsWith(prefix)
        )
        const retainedKeys = Object.keys(s.retainedAgentsByPaneKey).filter((k) =>
          k.startsWith(prefix)
        )
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey?.startsWith(prefix) ?? false
        )
        // See removeAgentStatus for rationale on ack cleanup. Apply this
        // regardless of live/retained presence — ack entries are owned by
        // the pane lifecycle independently of live/retained state.
        let nextAck = s.acknowledgedAgentsByPaneKey
        const ackKeys = Object.keys(nextAck).filter((k) => k.startsWith(prefix))
        if (ackKeys.length > 0) {
          nextAck = { ...nextAck }
          for (const k of ackKeys) {
            delete nextAck[k]
          }
        }
        const nextClosedTabs: Record<string, true> = {
          ...s.recentlyClosedAgentStatusTabIds,
          [tabIdPrefix]: true
        }

        if (
          liveKeys.length === 0 &&
          launchConfigKeys.length === 0 &&
          retainedKeys.length === 0 &&
          !migrationUnsupported.changed
        ) {
          if (nextAck !== s.acknowledgedAgentsByPaneKey) {
            return {
              acknowledgedAgentsByPaneKey: nextAck,
              recentlyClosedAgentStatusTabIds: nextClosedTabs
            }
          }
          return { recentlyClosedAgentStatusTabIds: nextClosedTabs }
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

        // Why: plant suppressors only for paneKeys that had a live entry,
        // mirroring the hasLive gate in dropAgentStatus — suppressors are
        // one-shot flags consumed by collectRetainedAgentsOnDisappear on a
        // live→gone transition, so a suppressor on a retained-only paneKey
        // would leak because no such transition will ever fire. Also skip
        // keys that are already suppressed so we don't spuriously reallocate
        // the suppressor map for subscribers that select on its identity.
        //
        // Same-frame race: if a hook ping promotes working→done in the same
        // render frame as teardown, the next retention-sync run sees the entry
        // as `done` in prevAgents and surfaces it in retained — even though
        // the user just tore it down. Planting suppressors is the cheap guard
        // for the common ordering; the rare inverse ordering has the same
        // bounded suppressor-leak tradeoff described in dropAgentStatus.
        const suppressorAdds = liveKeys.filter((k) => !(k in s.retentionSuppressedPaneKeys))
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
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          // Why: mirrors removeAgentStatusByTabPrefix — only bump the live-map
          // epoch / sortEpoch when the live map actually changed. Retained-only
          // sweeps do not participate in smart-sort or freshness calculations.
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
        // See removeAgentStatus for rationale on ack cleanup. Current tabs are
        // swept by prefix; attributed live rows and orphan retained rows are
        // swept by their retained/lifecycle key. Auto-hibernated completion
        // evidence keeps its read state so a slept card does not turn bold again.
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
        // Mirror dropAgentStatusByTabPrefix: when nothing live or retained
        // changed, narrow the return to just the ack delta (or s) so we don't
        // emit a new top-level state object that re-renders full-state
        // subscribers for nothing.
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

        // Why: normal worktree teardown folds the surface, so live rows need
        // suppressors. Auto-hibernated `done` rows become retained evidence
        // immediately, so suppressing those same pane keys would erase them on
        // the next retention sync.
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

    captureAllSleepingAgentSessions: () => {
      // Why: the quit flush must persist provider session ids for every live
      // agent pane — otherwise agents whose daemon PTYs die while the app is
      // closed have nothing to `--resume` from (#5232). Only live entries are
      // captured: retained rows belong to panes the user already closed, and
      // `done` sessions have nothing to resume.
      set((s) => {
        const capturedAt = Date.now()
        const next: Record<string, SleepingAgentSessionRecord> = {
          ...s.sleepingAgentSessionsByPaneKey
        }
        let changed = false
        for (const entry of Object.values(s.agentStatusByPaneKey)) {
          if (entry.state === 'done') {
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
            origin: 'quit'
          })
          if (record && next[record.paneKey] !== record) {
            next[record.paneKey] = record
            changed = true
          }
        }
        return changed ? { sleepingAgentSessionsByPaneKey: next } : s
      })
    },

    clearSleepingAgentSession: (paneKey) => {
      set((s) => {
        const hasSleepingRecord = paneKey in s.sleepingAgentSessionsByPaneKey
        const hasLaunchConfig = paneKey in s.agentLaunchConfigByPaneKey
        if (!hasSleepingRecord && !hasLaunchConfig) {
          return s
        }
        const nextSleeping = hasSleepingRecord
          ? { ...s.sleepingAgentSessionsByPaneKey }
          : s.sleepingAgentSessionsByPaneKey
        if (hasSleepingRecord) {
          delete nextSleeping[paneKey]
        }
        const nextLaunchConfigs = hasLaunchConfig
          ? { ...s.agentLaunchConfigByPaneKey }
          : s.agentLaunchConfigByPaneKey
        if (hasLaunchConfig) {
          delete nextLaunchConfigs[paneKey]
        }
        return {
          sleepingAgentSessionsByPaneKey: nextSleeping,
          agentLaunchConfigByPaneKey: nextLaunchConfigs
        }
      })
    },

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
      // Why: retained entries are a pure read-overlay — consumers read
      // retainedAgentsByPaneKey directly each render, so no sort/status epoch
      // bump is needed. Retention does not participate in sort ordering.
      // Batching into a single set(...) keeps multi-agent disappearance atomic.
      if (entries.length === 0) {
        return
      }
      set((s) => {
        // Why: skip the allocation + set(...) entirely when every input entry
        // is already present by reference. Consumers of retainedAgentsByPaneKey
        // select on its identity (the inline agents list), so a spurious map
        // reallocation forces re-renders even when nothing changed. Mirrors
        // the identity-preservation pattern used by pruneRetainedAgents and
        // clearRetentionSuppressedPaneKeys.
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
          // Why: INVARIANT — the map key equals retained.entry.paneKey. This
          // lets callers look up a retained row by the same paneKey they use
          // for agentStatusByPaneKey and keeps dismissal (dismissRetainedAgent)
          // keyed on a single identifier. collectRetainedAgentsOnDisappear
          // relies on this invariant too: it checks
          // `retainedAgentsByPaneKey[paneKey]` to decide whether a vanished
          // agent is already retained.
          next[retained.entry.paneKey] =
            entry === retained.entry ? retained : { ...retained, entry }
        }
        return { retainedAgentsByPaneKey: next }
      })
    },

    dismissRetainedAgent: (paneKey) => {
      // Why: no agentStatusEpoch / sortEpoch bump here (mirrors retainAgents).
      // Retained rows are a pure read-overlay on top of agentStatusByPaneKey —
      // they do not contribute to smart-sort class resolution (see
      // resolveAttention in smart-attention.ts, which reads
      // agentStatusByPaneKey only) and dashboard
      // selectors re-render on retainedAgentsByPaneKey identity changes
      // directly. Bumping epochs would force sidebar re-sorts and selector
      // recomputations for a change that cannot affect either result.
      set((s) => {
        if (!(paneKey in s.retainedAgentsByPaneKey)) {
          return s
        }
        const next = { ...s.retainedAgentsByPaneKey }
        delete next[paneKey]
        // Why: mirror dropAgentStatus's hasLive-gated suppressor. If the same
        // paneKey has BOTH a retained entry AND a concurrent live entry, simply
        // removing the retained row leaves the live entry free to vanish
        // cleanly on its next disappearance — and because
        // collectRetainedAgentsOnDisappear (useRetainedAgents.ts) only skips
        // paneKeys that are currently in retainedAgentsByPaneKey, the
        // just-dismissed row would be resurrected by a new retention snapshot.
        // Plant a one-shot suppressor so the next live→gone transition for
        // this paneKey is ignored by the retention sync.
        //
        // Gate on `paneKey in agentStatusByPaneKey`: with no live entry there
        // is no live→gone transition to guard against, and a stray suppressor
        // would leak indefinitely (same rationale as dropAgentStatus).
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
      // Why: collect inside set so we capture the exact paneKeys removed
      // (worktree filter is applied here). After the synchronous set()
      // returns, fan out a window.api.agentStatus.drop per removed key so
      // the main-process hook cache (and on-disk last-status file) eviction
      // matches the renderer's removal. Without this, the on-disk cache
      // would resurrect the dismissed rows on the next launch.
      const dismissedPaneKeys: string[] = []
      set((s) => {
        let changed = false
        const next: Record<string, RetainedAgentEntry> = {}
        // Why: mirror dismissRetainedAgent's hasLive-gated suppressor logic.
        // When a dismissed paneKey ALSO has a concurrent live entry in
        // agentStatusByPaneKey, removing the retained row alone lets the next
        // live→gone transition for that paneKey re-retain the row via the
        // retention sync (collectRetainedAgentsOnDisappear only skips paneKeys
        // currently present in retainedAgentsByPaneKey). Without planting a
        // suppressor here, "Dismiss all" for a worktree would silently
        // resurrect the just-dismissed rows as soon as the live agents
        // disappeared. Only plant suppressors for the hasLive subset — a stray
        // suppressor on a retained-only paneKey would leak indefinitely
        // because no live→gone transition would ever consume it.
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
      // Why: deliberately does NOT sweep retentionSuppressedPaneKeys for
      // pruned worktrees. PaneKeys are minted fresh when a worktree is
      // re-created (worktrees keep unique tab IDs), so stale suppressors
      // keyed on pruned paneKeys can never be matched by a future live entry
      // — they are inert and harmless. Sweeping them would add churn for no
      // observable benefit.
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
