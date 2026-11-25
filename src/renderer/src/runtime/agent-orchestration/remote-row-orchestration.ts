import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import { parseAgentStatusPaneIdentity } from '../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { orchestrationContextsEqual } from '@/store/slices/agent-status/orchestration/agent-status-orchestration-context'
import type { AppState } from '@/store/types'
import { aliasKey, rowIdentities, type RowIdentities } from './orchestration-row-identities'
import { terminalProvenance } from './terminal-provenance'

type Contexts = Record<string, AgentStatusOrchestrationContext>
type TerminalHosts = {
  ptys: ReadonlyMap<string, string | null>
  tabs: ReadonlyMap<string, string | null>
}

export const EMPTY_REMOTE_ROWS: Contexts = Object.freeze({})
type RemoteRowState = Parameters<typeof rowIdentities>[0] &
  Parameters<typeof terminalProvenance>[0] &
  Partial<Pick<AppState, 'runtimeAgentOrchestrationByPaneKey' | 'remoteAgentOrchestrationByHost'>>

let cache: { inputs: unknown[]; contexts: Contexts } | undefined

/** The row this window shows for a host's pane key: that host's chat row, or a terminal tab it runs. */
function rowOnHost(
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
  const terminalHost = tabId ? (terminals.tabs.get(tabId) ?? terminals.ptys.get(tabId)) : undefined
  return terminalHost === host ? key : undefined
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
  if (!byHost || Object.keys(byHost).length === 0) {
    return EMPTY_REMOTE_ROWS
  }
  const inputs = [byHost, rows, terminals]
  if (cache && inputs.every((value, index) => value === cache?.inputs[index])) {
    return cache.contexts
  }
  const previous = cache?.contexts
  const contexts: Contexts = Object.fromEntries([])
  for (const [host, hostContexts] of Object.entries(byHost)) {
    for (const [key, context] of Object.entries(hostContexts)) {
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
      contexts[row] =
        next !== context && kept && orchestrationContextsEqual(kept, next) ? kept : next
    }
  }
  const keys = Object.keys(contexts)
  const unchanged =
    previous &&
    keys.length === Object.keys(previous).length &&
    keys.every((key) => previous[key] === contexts[key])
  cache = { inputs, contexts: unchanged ? previous : contexts }
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
  if (!byHost || Object.keys(byHost).length === 0) {
    return EMPTY_REMOTE_ROWS
  }
  return remoteRowContexts(
    state.remoteAgentOrchestrationByHost,
    rowIdentities(state),
    terminalProvenance(state)
  )
}
