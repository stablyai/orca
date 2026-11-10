import { i18n } from '@/i18n/i18n'
import { getTranslationResourceVersion } from '@/i18n/translation-resource-version'
import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { parseAgentStatusPaneIdentity } from '../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { freshActivityLiveAgentState } from './activity-event-state'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../shared/agent-status/contracts/agent-status-types'
import type { MigrationUnsupportedPtyEntry } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { StructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import type { Repo } from '../../../../shared/repo-types'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type {
  ActivityEvent,
  ActivityLiveAgentSnapshot,
  ActivityPassiveAgentSnapshot
} from './activity-thread-types'
import { capActivityEvents } from './activity-event-cap'
import './activity-pane-events'
import {
  resolveActivityTabIndexes,
  resolvePaneBuild,
  type ActivityEventBuildCache
} from './activity-event-build-cache'
import { appendUnsupportedEvents } from './activity-event-builder-sources'
import {
  attributedActivityTabContext,
  resolveActivityEventOwner,
  selectActivityEventOwner,
  resolveActivityExecutionHostId,
  type ActivityEventOwner
} from './activity-event-builder-context'
import type { Translate } from '@/i18n/use-translate'

export type BuildActivityEventsArgs = {
  chatNames: StructuredChatTabNames
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  sleepingAgentStatusByPaneKey?: ReadonlyMap<string, AgentStatusEntry>
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>
  tabsByWorktree: Record<string, TerminalTab[]>
  unifiedTabsByWorktree?: Record<string, Tab[]>
  worktreeMap: Map<string, Worktree>
  repoMap: Map<string, Repo>
  repos?: readonly Repo[]
  resolveWorktree?: (worktreeId: string, executionHostId?: ExecutionHostId) => Worktree | undefined
  acknowledgedAgentsByPaneKey: Record<string, number>
  /** Per-pane "Clear completed" cutoffs; events stamped at or before the cutoff are hidden. */
  activityClearedAtByPaneKey?: Record<string, number>
  ownerCatalog?: readonly unknown[]
  now: number
}

export function buildActivityEvents(
  args: BuildActivityEventsArgs,
  cache?: ActivityEventBuildCache,
  t?: Translate
): {
  events: ActivityEvent[]
  liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot>
  paneEntryByPaneKey: Record<string, AgentStatusEntry>
  passiveAgentByPaneKey: Record<string, ActivityPassiveAgentSnapshot>
} {
  const events: ActivityEvent[] = []
  const passiveAgentByPaneKey: Record<string, ActivityPassiveAgentSnapshot> = {}
  const paneEntryByPaneKey: Record<string, AgentStatusEntry> = {}
  const seenEventIds = new Set<string>()
  const { context: tabContext, hosts: tabHostIndex } = resolveActivityTabIndexes(args, cache)
  const ownerCache = new Map<string, ActivityEventOwner>()
  const liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot> = {}
  const seenCacheKeys = cache ? new Set<string>() : null

  const pushPaneEvents = (paneEvents: ActivityEvent[], rowEntry: AgentStatusEntry): void => {
    // Preserve globally unique event IDs with first-source precedence.
    paneEntryByPaneKey[rowEntry.paneKey] ??= rowEntry
    for (const event of paneEvents) {
      if (seenEventIds.has(event.id)) {
        continue
      }
      seenEventIds.add(event.id)
      events.push(event)
    }
  }

  const appendEntry = (paneKey: string, entry: AgentStatusEntry, sleeping: boolean) => {
    const parsed = parseAgentStatusPaneIdentity(
      paneKey,
      args.unifiedTabsByWorktree
        ? getStructuredAgentSessionTabsByPaneKey(args.unifiedTabsByWorktree).get(paneKey)
        : undefined
    )
    if (!parsed) {
      return
    }
    const context = tabContext.get(parsed.tabId) ?? attributedActivityTabContext(entry)
    if (!context) {
      return
    }
    const owner = resolveActivityEventOwner(
      args,
      context,
      entry,
      context.tab.ptyId,
      tabHostIndex,
      ownerCache,
      t
    )
    const passive = sleeping || entry.sessionBoundary === true
    if (passive) {
      passiveAgentByPaneKey[paneKey] = {
        timestamp: entry.stateStartedAt,
        worktree: owner.worktree,
        repo: owner.repo,
        entry,
        tab: context.tab,
        agentType: entry.agentType ?? 'unknown'
      }
    }
    const orchestration = args.runtimeAgentOrchestrationByPaneKey?.[paneKey]
    // Only fresh raw live state proves working; history and orchestration enrichment cannot establish liveness.
    const liveState = passive ? null : freshActivityLiveAgentState(entry, args.now)
    const {
      events: paneEvents,
      live,
      rowEntry
    } = resolvePaneBuild(
      {
        cacheKey: `${sleeping ? 'sleep' : 'live'}:${paneKey}`,
        source: entry,
        entry,
        orchestration,
        worktree: owner.worktree,
        repo: owner.repo,
        tab: context.tab,
        agentType: entry.agentType ?? 'unknown',
        agentAlive: !passive,
        acknowledgedAt: args.acknowledgedAgentsByPaneKey[paneKey] ?? 0,
        clearedAt: args.activityClearedAtByPaneKey?.[paneKey] ?? 0,
        liveState
      },
      cache,
      seenCacheKeys
    )
    if (passive) {
      passiveAgentByPaneKey[paneKey].entry = rowEntry
    }
    if (live) {
      liveAgentByPaneKey[paneKey] = live
    }
    pushPaneEvents(paneEvents, rowEntry)
    return { events: paneEvents, rowEntry, passive: passiveAgentByPaneKey[paneKey] }
  }
  for (const [paneKey, entry] of Object.entries(args.agentStatusByPaneKey)) {
    appendEntry(paneKey, entry, false)
  }
  const ownerInputs = [
    args.worktreeMap,
    args.repoMap,
    args.repos,
    args.resolveWorktree,
    t,
    i18n.language,
    getTranslationResourceVersion(),
    ...(args.ownerCatalog ?? [])
  ]
  const previousOwners = cache?.owners
  const reuseOwners =
    previousOwners &&
    ownerInputs.length === previousOwners.inputs.length &&
    ownerInputs.every((input, i) => input === previousOwners.inputs[i]) &&
    (!args.resolveWorktree || args.ownerCatalog !== undefined)
  const owners = new Map<string, ActivityEventOwner>()
  const sleepRows: NonNullable<ActivityEventBuildCache['sleep']>['rows'] = new Map()
  for (const [paneKey, entry] of args.sleepingAgentStatusByPaneKey ?? []) {
    if (args.agentStatusByPaneKey[paneKey]) {
      continue
    }
    const parsed = parseAgentStatusPaneIdentity(
      paneKey,
      args.unifiedTabsByWorktree
        ? getStructuredAgentSessionTabsByPaneKey(args.unifiedTabsByWorktree).get(paneKey)
        : undefined
    )
    const context = parsed && (tabContext.get(parsed.tabId) ?? attributedActivityTabContext(entry))
    if (!context) {
      continue
    }
    const host = resolveActivityExecutionHostId(context, entry, context.tab.ptyId, tabHostIndex)
    const ownerKey = `${context.worktreeId}\0${host ?? ''}\0${Boolean(args.tabsByWorktree[context.worktreeId])}`
    let owner = owners.get(ownerKey)
    if (!owner) {
      owner = reuseOwners ? previousOwners.rows.get(ownerKey) : undefined
      owner ??= selectActivityEventOwner(
        args,
        context,
        entry,
        context.tab.ptyId,
        tabHostIndex,
        new Map(),
        t
      )
      owners.set(ownerKey, owner)
    }
    const inputs = [
      entry,
      context.worktreeId,
      context.tab,
      host,
      owner.worktree,
      owner.repo,
      owner.knownWorktree,
      args.runtimeAgentOrchestrationByPaneKey?.[paneKey],
      args.acknowledgedAgentsByPaneKey[paneKey] ?? 0,
      args.activityClearedAtByPaneKey?.[paneKey] ?? 0,
      owner.standalone ? t : undefined,
      owner.standalone ? i18n.language : undefined,
      owner.standalone ? getTranslationResourceVersion() : undefined
    ]
    const previous = cache?.sleep?.rows.get(paneKey)
    if (previous && inputs.every((input, i) => input === previous.inputs[i])) {
      seenCacheKeys?.add(`sleep:${paneKey}`)
      passiveAgentByPaneKey[paneKey] = previous.passive
      pushPaneEvents(previous.events, previous.rowEntry)
      sleepRows.set(paneKey, previous)
      continue
    }
    // Feed the selected owner into the existing builder without repeating owner selection.
    ownerCache.set(`${context.worktreeId}\0${host ?? ''}`, owner)
    const built = appendEntry(paneKey, entry, true)
    if (built?.passive) {
      sleepRows.set(paneKey, { inputs, source: entry, ...built })
    }
  }
  if (cache) {
    cache.owners = { inputs: ownerInputs, rows: owners }
    cache.sleep = { rows: sleepRows }
  }

  appendUnsupportedEvents({
    args,
    cache,
    seenCacheKeys,
    liveAgentByPaneKey,
    tabContext,
    resolveOwner: (context, entry, terminalPtyId) =>
      resolveActivityEventOwner(args, context, entry, terminalPtyId, tabHostIndex, ownerCache),
    pushPaneEvents
  })

  // Evict panes absent from every source so caches cannot outgrow live maps.
  if (cache && seenCacheKeys) {
    for (const cacheKey of cache.panes.keys()) {
      if (!seenCacheKeys.has(cacheKey)) {
        cache.panes.delete(cacheKey)
      }
    }
  }
  return {
    events: capActivityEvents(events),
    liveAgentByPaneKey,
    paneEntryByPaneKey,
    passiveAgentByPaneKey
  }
}
