import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import { parseAgentStatusPaneIdentity } from '../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { orchestrationContextsEqual } from '@/store/slices/agent-status/orchestration/agent-status-orchestration-context'
import { aliasKey, type RowIdentities } from './orchestration-row-identities'

type Contexts = Record<string, AgentStatusOrchestrationContext>
type TerminalHosts = {
  ptys: ReadonlyMap<string, string | null>
  tabs: ReadonlyMap<string, string | null>
}

export const EMPTY_REMOTE_ROWS: Contexts = Object.freeze({})

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

/** Remote hosts' contexts for the rows each host runs here, by row key. A context for a pane no
 *  window row of that host shows is dropped, so it can never re-parent this computer's rows. */
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
      // A parent the host names keeps its own key unless this window shows that host's chat under another.
      const parent = parentKey
        ? (rows.aliases.get(aliasKey(host, parentKey)) ?? parentKey)
        : undefined
      const next = parent === parentKey ? context : { ...context, parentPaneKey: parent }
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
