import { translate } from '@/i18n/i18n'
import { getCodexAccountDisplayLabel } from '@/lib/codex-account-display-label'
import {
  resolvePaneRunAccount,
  type IdentityRowRunAccounts
} from '@/store/agent-identity-row-run-accounts'
import type { AgentRunAccount, AgentRunAccountProvider } from '../../../../shared/agent-run-account'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import {
  collectLayoutLeafIdsInOrder,
  resolveRootlessTerminalLayoutLeafId
} from '../../../../shared/workspace-layout/terminal-pane-tree'

export type TabAgentAccountSettings = Pick<
  GlobalSettings,
  | 'claudeManagedAccounts'
  | 'codexManagedAccounts'
  | 'activeClaudeManagedAccountId'
  | 'activeClaudeManagedAccountIdsByRuntime'
  | 'activeCodexManagedAccountId'
  | 'activeCodexManagedAccountIdsByRuntime'
>

export type TabAgentAccount = {
  paneKey: string
  ptyId: string | undefined
  provider: AgentRunAccountProvider
  /** "Claude", or "Claude 2" when a split tab runs more than one agent. */
  agentLabel: string
  accountLabel: string
  note: string
  kept: boolean
  keepDisabledReason?: NonNullable<AgentRunAccount['keepUnavailable']>
}

// Why the catalog's own keys, not the catalog: its module builds every agent entry on import.
function providerLabel(provider: AgentRunAccountProvider): string {
  return provider === 'claude'
    ? translate('auto.lib.agent.catalog.0708ed89f1', 'Claude')
    : translate('auto.lib.agent.catalog.760bc6883d', 'Codex')
}

function selectedAccountId(
  settings: TabAgentAccountSettings,
  provider: AgentRunAccountProvider
): string | null {
  return provider === 'claude'
    ? (settings.activeClaudeManagedAccountIdsByRuntime?.host ??
        settings.activeClaudeManagedAccountId ??
        null)
    : (settings.activeCodexManagedAccountIdsByRuntime?.host ??
        settings.activeCodexManagedAccountId ??
        null)
}

function accountLabel(settings: TabAgentAccountSettings, facet: AgentRunAccount): string {
  if (facet.accountId === null) {
    return translate('components.tab.bar.tabAgentAccounts.systemDefault', 'System default')
  }
  if (facet.provider === 'claude') {
    const account = settings.claudeManagedAccounts.find((entry) => entry.id === facet.accountId)
    if (account) {
      return account.email
    }
  } else {
    const account = settings.codexManagedAccounts.find((entry) => entry.id === facet.accountId)
    if (account) {
      return getCodexAccountDisplayLabel(account, settings.codexManagedAccounts)
    }
  }
  return translate('components.tab.bar.tabAgentAccounts.removedAccount', 'Removed account')
}

/** Presentation only: the host decides kept/follow; this says what that means for the next start. */
function accountNote(settings: TabAgentAccountSettings, facet: AgentRunAccount): string {
  if (facet.mode === 'kept') {
    return facet.provider === 'claude' && facet.shellRoute !== 'account'
      ? translate(
          'components.tab.bar.tabAgentAccounts.keptFromNextStart',
          'Kept on this account from its next start'
        )
      : translate('components.tab.bar.tabAgentAccounts.kept', 'Kept on this account')
  }
  return facet.accountId === selectedAccountId(settings, facet.provider) &&
    facet.shellRoute !== 'account'
    ? translate('components.tab.bar.tabAgentAccounts.follows', 'Follows the selected account')
    : translate(
        'components.tab.bar.tabAgentAccounts.followsFromNextStart',
        'Follows the selected account from its next start'
      )
}

/** One entry per agent pane whose host published its account, in layout order. */
export function describeTabAgentAccounts(args: {
  tabId: string
  layout: TerminalLayoutSnapshot | undefined
  rows: Readonly<Record<string, AgentStatusEntry>>
  /** Facets on the host's identity-only rows, which no status entry carries. */
  identityRows?: IdentityRowRunAccounts
  settings: TabAgentAccountSettings | null | undefined
}): TabAgentAccount[] {
  const { tabId, layout, rows, identityRows, settings } = args
  if (!settings) {
    return []
  }
  const ordered = collectLayoutLeafIdsInOrder(layout?.root)
  const rootless = layout && !layout.root ? resolveRootlessTerminalLayoutLeafId(layout) : null
  const leafIds = ordered.length > 0 ? ordered : rootless ? [rootless] : []
  const panes = leafIds.flatMap((leafId) => {
    const paneKey = makePaneKey(tabId, leafId)
    // Why resolved: a dead terminal's kept agent survives only as an identity row, and its
    // refused resume sends the person here to un-keep it. Local panes only, either way.
    const facet = resolvePaneRunAccount(paneKey, rows[paneKey], identityRows)
    return facet ? [{ paneKey, ptyId: layout?.ptyIdsByLeafId?.[leafId], facet }] : []
  })
  const seen = new Map<AgentRunAccountProvider, number>()
  return panes.map(({ paneKey, ptyId, facet }) => {
    const index = (seen.get(facet.provider) ?? 0) + 1
    seen.set(facet.provider, index)
    const label = providerLabel(facet.provider)
    return {
      paneKey,
      ptyId,
      provider: facet.provider,
      agentLabel: panes.length > 1 ? `${label} ${index}` : label,
      accountLabel: accountLabel(settings, facet),
      note: accountNote(settings, facet),
      kept: facet.mode === 'kept',
      ...(facet.keepUnavailable ? { keepDisabledReason: facet.keepUnavailable } : {})
    }
  })
}
