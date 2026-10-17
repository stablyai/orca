import {
  resolvePaneRunAccount,
  type IdentityRowRunAccounts
} from '@/store/agent-identity-row-run-accounts'
import type { AgentRunAccountProvider } from '../../../../shared/agent-run-account'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { getTabIdToWorktreeId } from '../sidebar/worktree-agent-row-selectors'

type CountCache = {
  rows: Readonly<Record<string, AgentStatusEntry>>
  identityRows: IdentityRowRunAccounts
  tabsByWorktree: Readonly<Record<string, TerminalTab[]>> | undefined
  counts: Map<string, number>
}

const NO_TABS: Readonly<Record<string, TerminalTab[]>> = {}
const NO_IDENTITY_ROWS: IdentityRowRunAccounts = {}
let cache: CountCache | null = null

function countKey(
  provider: AgentRunAccountProvider,
  accountId: string | null,
  keptOnly = false
): string {
  return `${provider}:${accountId ?? ''}${keptOnly ? ':kept' : ''}`
}

/** Terminal agents on this host per provider and account, counting only rows whose tab is open. */
export function countTerminalAgentsByAccount(args: {
  rows: Readonly<Record<string, AgentStatusEntry>>
  /** Facets on the host's identity-only rows, which no status entry carries. */
  identityRows?: IdentityRowRunAccounts
  /** Undefined in stores that never loaded tabs; no tab is open then. */
  tabsByWorktree: Readonly<Record<string, TerminalTab[]>> | undefined
  provider: AgentRunAccountProvider
  accountId: string | null
  /** Only agents a person kept on the account. */
  keptOnly?: boolean
}): number {
  const identityRows = args.identityRows ?? NO_IDENTITY_ROWS
  if (
    !cache ||
    cache.rows !== args.rows ||
    cache.identityRows !== identityRows ||
    cache.tabsByWorktree !== args.tabsByWorktree
  ) {
    const openTabs = getTabIdToWorktreeId(args.tabsByWorktree ?? NO_TABS)
    const counts = new Map<string, number>()
    const paneKeys = new Set([...Object.keys(args.rows), ...Object.keys(identityRows)])
    for (const paneKey of paneKeys) {
      const facet = resolvePaneRunAccount(paneKey, args.rows[paneKey], identityRows)
      const tabId = parsePaneKey(paneKey)?.tabId
      if (!facet || facet.lane !== 'host' || !tabId || !openTabs.has(tabId)) {
        continue
      }
      const key = countKey(facet.provider, facet.accountId)
      counts.set(key, (counts.get(key) ?? 0) + 1)
      if (facet.mode === 'kept') {
        const keptKey = countKey(facet.provider, facet.accountId, true)
        counts.set(keptKey, (counts.get(keptKey) ?? 0) + 1)
      }
    }
    cache = { rows: args.rows, identityRows, tabsByWorktree: args.tabsByWorktree, counts }
  }
  return cache.counts.get(countKey(args.provider, args.accountId, args.keptOnly)) ?? 0
}
