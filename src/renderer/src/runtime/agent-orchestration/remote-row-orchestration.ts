import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import { parseAgentStatusPaneIdentity } from '../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { makePaneKey, parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/workspace-layout/terminal-surface-id'
import { orchestrationContextsEqual } from '@/store/slices/agent-status/orchestration/agent-status-orchestration-context'
import type { AppState } from '@/store/types'
import { aliasKey, rowIdentities, type RowIdentities } from './orchestration-row-identities'
import { terminalProvenance } from './terminal-provenance'

type Contexts = Record<string, AgentStatusOrchestrationContext>
export type TerminalHosts = {
  ptys: ReadonlyMap<string, string | null>
  tabs: ReadonlyMap<string, string | null>
}

export const EMPTY_REMOTE_ROWS: Contexts = Object.freeze({})
type RemoteRowState = Parameters<typeof rowIdentities>[0] &
  Parameters<typeof terminalProvenance>[0] &
  Partial<Pick<AppState, 'runtimeAgentOrchestrationByPaneKey' | 'remoteAgentOrchestrationByHost'>>

let cache:
  | {
      byHost: Record<string, Contexts>
      rows: RowIdentities
      terminals: TerminalHosts
      contexts: Contexts
    }
  | undefined

function hasOwnKey(record: Record<string, unknown>): boolean {
  for (const key in record) {
    if (Object.hasOwn(record, key)) {
      return true
    }
  }
  return false
}

function contextsShallowEqual(previous: Contexts, next: Contexts, nextCount: number): boolean {
  let prevCount = 0
  for (const key in previous) {
    if (!Object.hasOwn(previous, key)) {
      continue
    }
    prevCount += 1
    if (previous[key] !== next[key]) {
      return false
    }
  }
  return prevCount === nextCount
}

/** The row this window shows for a host's pane key: that host's chat row, or a terminal tab it runs. */
export function rowOnHost(
  host: string,
  key: string,
  rows: RowIdentities,
  terminals: TerminalHosts
): string | undefined {
  const chat = rows.aliases.get(aliasKey(host, key))
  if (chat) {
    return chat
  }
  const tabId = parseAgentStatusPaneIdentity(key)?.tabId
  if (tabId && terminalHostOf(tabId, terminals) === host) {
    return key
  }
  // A runtime host's terminal is mirrored here as `web-terminal-<hostTab>`; the leaf is unchanged.
  const pane = parsePaneKey(key)
  if (!pane) {
    return undefined
  }
  const mirroredTabId = toWebTerminalSurfaceTabId(pane.tabId)
  return terminalHostOf(mirroredTabId, terminals) === host
    ? makePaneKey(mirroredTabId, pane.leafId)
    : undefined
}

function terminalHostOf(tabId: string, terminals: TerminalHosts): string | null | undefined {
  return terminals.tabs.get(tabId) ?? terminals.ptys.get(tabId)
}

function withoutParent(context: AgentStatusOrchestrationContext): AgentStatusOrchestrationContext {
  const { parentPaneKey: _dropped, ...rest } = context
  return rest
}

/** Remote contexts for rows their host runs here, by row key; others drop, never touching local rows. */
export function remoteRowContexts(
  byHost: Record<string, Contexts> | undefined,
  rows: RowIdentities,
  terminals: TerminalHosts
): Contexts {
  if (!byHost || !hasOwnKey(byHost)) {
    return EMPTY_REMOTE_ROWS
  }
  if (cache && cache.byHost === byHost && cache.rows === rows && cache.terminals === terminals) {
    return cache.contexts
  }
  const previous = cache?.contexts
  const contexts: Contexts = {}
  let contextCount = 0
  for (const host in byHost) {
    if (!Object.hasOwn(byHost, host)) {
      continue
    }
    const hostContexts = byHost[host]
    for (const key in hostContexts) {
      if (!Object.hasOwn(hostContexts, key)) {
        continue
      }
      const context = hostContexts[key]
      const row = rowOnHost(host, key, rows, terminals)
      if (!row) {
        continue
      }
      const parentKey = context.parentPaneKey
      // A host's parent must be a row that same host runs here; otherwise the link is dropped.
      const parent = parentKey ? rowOnHost(host, parentKey, rows, terminals) : undefined
      const next =
        parent === parentKey
          ? context
          : parent
            ? { ...context, parentPaneKey: parent }
            : withoutParent(context)
      const kept = previous?.[row]
      if (!Object.hasOwn(contexts, row)) {
        contextCount += 1
      }
      contexts[row] =
        next !== context && kept && orchestrationContextsEqual(kept, next) ? kept : next
    }
  }
  const unchanged = previous !== undefined && contextsShallowEqual(previous, contexts, contextCount)
  cache = { byHost, rows, terminals, contexts: unchanged ? previous : contexts }
  return cache.contexts
}

let statusRowsCache: { local: Contexts; remote: Contexts; merged: Contexts } | undefined

/** Status rows read this computer's map unchanged, with only remote-run rows taking their host's context. */
export function orchestrationForStatusRows(state: RemoteRowState): Contexts {
  const local = state.runtimeAgentOrchestrationByPaneKey ?? EMPTY_REMOTE_ROWS
  const remote = remoteRowContextsFor(state)
  if (remote === EMPTY_REMOTE_ROWS) {
    return local
  }
  if (statusRowsCache?.local !== local || statusRowsCache.remote !== remote) {
    statusRowsCache = { local, remote, merged: { ...local, ...remote } }
  }
  return statusRowsCache.merged
}

/** The remote contexts applied to rows, by row key; identity holds while no applied context changed. */
export function remoteRowContextsFor(state: RemoteRowState): Contexts {
  const byHost = state.remoteAgentOrchestrationByHost
  // A purely local window builds no row identities or terminal hosts for this.
  if (!byHost || !hasOwnKey(byHost)) {
    return EMPTY_REMOTE_ROWS
  }
  return remoteRowContexts(byHost, rowIdentities(state), terminalProvenance(state))
}
