import type { AppState } from '@/store/types'
import type { WorktreeRuntimeOwnerState } from '@/lib/workspace/ownership/worktree-runtime-owner-state'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { parseAgentStatusPaneIdentity } from '../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import { keyedListsMatch } from '@/store/record-transitions/keyed-list-match'
import { orchestrationContextsEqual } from '@/store/slices/agent-status/orchestration/agent-status-orchestration-context'
import { resolveStructuredAgentSessionOwner } from '../native-chat/session-ownership/structured-agent-session-owner'
import {
  aliasKey,
  orchestrationRowWorkForTest,
  rowIdentities
} from './orchestration-row-identities'

type Contexts = Record<string, AgentStatusOrchestrationContext>
export type VisibleOrchestrationState = WorktreeRuntimeOwnerState &
  Partial<
    Pick<
      AppState,
      | 'unifiedTabsByWorktree'
      | 'agentStatusByPaneKey'
      | 'runtimeAgentOrchestrationByPaneKey'
      | 'ptyIdsByTabId'
    >
  > & {
    tabsByWorktree?: Record<string, readonly { id: string; ptyId?: string | null }[]>
  }
const EMPTY: Record<string, never> = {}
const producerByContext = new WeakMap<AgentStatusOrchestrationContext, string>()
export function orchestrationProducer(context: AgentStatusOrchestrationContext): string {
  return producerByContext.get(context) ?? LOCAL_EXECUTION_HOST_ID
}
export function recordOrchestrationProducer(
  context: AgentStatusOrchestrationContext,
  host: string
): void {
  producerByContext.set(context, host)
}
let cache: { inputs: unknown[]; contexts: Contexts } | undefined
let visits = 0
export function visibleOrchestrationWorkForTest(): { visits: number; paneKeyEncodes: number } {
  const rows = orchestrationRowWorkForTest()
  return { visits: visits + rows.visits, paneKeyEncodes: rows.paneKeyEncodes }
}
type TerminalInputs = Pick<
  VisibleOrchestrationState,
  'unifiedTabsByWorktree' | 'tabsByWorktree' | 'ptyIdsByTabId'
>
let terminalCache:
  | {
      inputs: TerminalInputs
      hosts: Map<string, string | null>
      ptys: Map<string, string | null>
    }
  | undefined

// Why: only rows whose identity, host or pty changed can move provenance; title writes never do.
function terminalProvenanceInputsMatch(state: TerminalInputs, previous: TerminalInputs): boolean {
  return (
    keyedListsMatch(state.ptyIdsByTabId, previous.ptyIdsByTabId, (a, b) => a === b) &&
    keyedListsMatch(
      state.unifiedTabsByWorktree,
      previous.unifiedTabsByWorktree,
      (a, b) =>
        a.contentType === b.contentType &&
        a.worktreeId === b.worktreeId &&
        a.entityId === b.entityId &&
        a.executionHostId === b.executionHostId
    ) &&
    keyedListsMatch(
      state.tabsByWorktree,
      previous.tabsByWorktree,
      (a, b) => a.id === b.id && a.ptyId === b.ptyId
    )
  )
}

function terminalProvenance(state: VisibleOrchestrationState) {
  const inputs: TerminalInputs = {
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    tabsByWorktree: state.tabsByWorktree,
    ptyIdsByTabId: state.ptyIdsByTabId
  }
  if (terminalCache && terminalProvenanceInputsMatch(inputs, terminalCache.inputs)) {
    // The same object keeps the orchestration projection cached across title-only writes.
    terminalCache.inputs = inputs
    return terminalCache
  }
  const hosts = new Map<string, string | null>()
  const ptys = new Map<string, string | null>()
  const merge = (map: Map<string, string | null>, key: string, host: string | null) => {
    map.set(key, map.has(key) && map.get(key) !== host ? null : host)
  }
  const ptyHost = (id?: string | null): string | null | undefined => {
    if (!id) {
      return undefined
    }
    const remote = parseRemoteRuntimePtyId(id)
    return remote?.environmentId
      ? toRuntimeExecutionHostId(remote.environmentId)
      : isRemoteRuntimePtyId(id)
        ? null
        : undefined
  }
  for (const [tab, ids] of Object.entries(state.ptyIdsByTabId ?? EMPTY)) {
    for (const id of ids) {
      visits++
      const host = ptyHost(id)
      if (host !== undefined) {
        merge(ptys, tab, host)
      }
    }
  }
  for (const tabs of Object.values(state.unifiedTabsByWorktree ?? EMPTY)) {
    for (const tab of tabs) {
      visits++
      if (tab.contentType === 'terminal' && tab.executionHostId) {
        merge(hosts, aliasKey(tab.worktreeId, tab.entityId), tab.executionHostId)
      }
    }
  }
  for (const [worktree, tabs] of Object.entries(state.tabsByWorktree ?? EMPTY)) {
    for (const tab of tabs) {
      visits++
      const host = ptyHost(tab.ptyId)
      if (host !== undefined) {
        merge(hosts, aliasKey(worktree, tab.id), host)
      }
    }
  }
  terminalCache = { inputs, hosts, ptys }
  return terminalCache
}

function projection(state: VisibleOrchestrationState): NonNullable<typeof cache> {
  const rows = rowIdentities(state)
  const terminals = terminalProvenance(state)
  const inputs = [
    state.runtimeAgentOrchestrationByPaneKey,
    state.agentStatusByPaneKey,
    terminals,
    rows
  ]
  if (cache && inputs.every((value, index) => value === cache?.inputs[index])) {
    return cache
  }
  const { aliases, canonical } = rows
  const contexts: Contexts = Object.fromEntries([])
  const visibleKey = (key: string, host: string | null) => {
    if (!host) {
      return canonical.has(key) ? aliasKey('unknown', key) : key
    }
    const alias = aliases.get(aliasKey(host, key))
    // An identically spelled row from another runtime cannot satisfy this relationship.
    return (
      alias ?? (canonical.has(key) && canonical.get(key)?.host !== host ? aliasKey(host, key) : key)
    )
  }
  const adapt = (key: string, context: AgentStatusOrchestrationContext, host: string | null) => {
    visits++
    const actual = visibleKey(key, host)
    const parent = context.parentPaneKey ? visibleKey(context.parentPaneKey, host) : undefined
    const next = parent === context.parentPaneKey ? context : { ...context, parentPaneKey: parent }
    const previous = cache?.contexts[actual]
    contexts[actual] =
      next !== context && previous && orchestrationContextsEqual(previous, next) ? previous : next
  }
  for (const [key, context] of Object.entries(state.runtimeAgentOrchestrationByPaneKey ?? EMPTY)) {
    adapt(key, context, producerByContext.get(context) ?? LOCAL_EXECUTION_HOST_ID)
  }
  const embedded = (
    entry: NonNullable<ReturnType<AppState['agentStatusByPaneKey']['get']>>,
    worktreeId = entry.worktreeId
  ) => {
    visits++
    if (!entry?.orchestration) {
      return
    }
    const row = canonical.get(entry.paneKey)
    const runtime = state.runtimeAgentOrchestrationByPaneKey?.[row?.key ?? entry.paneKey]
    if (
      runtime &&
      (!row || row.host === orchestrationProducer(runtime)) &&
      runtime.taskId === entry.orchestration.taskId &&
      runtime.dispatchId === entry.orchestration.dispatchId
    ) {
      // Matching graph facts already carry the context's producer, independently of execution routing.
      return
    }
    const tabId = parseAgentStatusPaneIdentity(entry.paneKey)?.tabId
    const terminalKey = worktreeId && tabId ? aliasKey(worktreeId, tabId) : null
    const tabHost = terminalKey ? terminals.hosts.get(terminalKey) : undefined
    const ptyHost = tabId ? terminals.ptys.get(tabId) : undefined
    const terminalHost =
      tabHost === undefined
        ? ptyHost
        : ptyHost === undefined || tabHost === ptyHost
          ? tabHost
          : null
    const host = row
      ? row.host
      : terminalHost !== undefined
        ? terminalHost
        : !entry.connectionId && worktreeId
          ? resolveStructuredAgentSessionOwner(state, worktreeId)
          : null
    if (
      entry.orchestration.parentPaneKey &&
      visibleKey(entry.orchestration.parentPaneKey, host) !== entry.orchestration.parentPaneKey
    ) {
      adapt(entry.paneKey, entry.orchestration, host)
    }
  }
  for (const entry of Array.from(state.agentStatusByPaneKey?.values() ?? [])) {
    embedded(entry)
  }
  const previous = cache?.contexts
  const equal =
    previous &&
    Object.keys(previous).length === Object.keys(contexts).length &&
    Object.keys(contexts).every((key) => previous[key] === contexts[key])
  cache = { inputs, contexts: equal ? previous : contexts }
  return cache
}

/** Canonical contexts stay in storage; actual rows and parent aliases are a shared read-only view. */
export function selectVisibleAgentOrchestration(state: VisibleOrchestrationState): Contexts {
  if (!state.unifiedTabsByWorktree) {
    return state.runtimeAgentOrchestrationByPaneKey ?? EMPTY
  }
  return projection(state).contexts
}

/** The same row identity joins graph enrichment and first status paint, without translating stored parents. */
export function canonicalOrchestrationForRow(
  state: VisibleOrchestrationState,
  paneKey: string
): AgentStatusOrchestrationContext | undefined {
  const row = rowIdentities(state).canonical.get(paneKey)
  const context = state.runtimeAgentOrchestrationByPaneKey?.[row?.key ?? paneKey]
  return context &&
    (!row || row.host === (producerByContext.get(context) ?? LOCAL_EXECUTION_HOST_ID))
    ? context
    : undefined
}

export function representedOrchestrationWorktrees(
  state: VisibleOrchestrationState
): ReadonlyMap<string, string> {
  return rowIdentities(state).worktrees
}
