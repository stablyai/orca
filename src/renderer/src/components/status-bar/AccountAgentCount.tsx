import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { useIdentityRowRunAccounts } from '../../store/agent-identity-row-run-accounts'
import type { AgentRunAccountProvider } from '../../../../shared/agent-run-account'
import { countTerminalAgentsByAccount } from './count-terminal-agents-by-account'

const EMPTY_ROWS = {}

/** "N terminal agents" on an account row; this host's local panes only, hidden at zero. */
export function AccountAgentCount({
  provider,
  accountId,
  enabled
}: {
  provider: AgentRunAccountProvider
  accountId: string | null
  /** Off for another runtime's or a WSL lane's accounts, whose agents this host does not see. */
  enabled: boolean
}): React.JSX.Element | null {
  const identityRows = useIdentityRowRunAccounts((state) => state.byPaneKey)
  const count = useAppStore((state) =>
    enabled
      ? countTerminalAgentsByAccount({
          rows: state.agentStatusByPaneKey ?? EMPTY_ROWS,
          identityRows,
          tabsByWorktree: state.tabsByWorktree,
          provider,
          accountId
        })
      : 0
  )
  if (count === 0) {
    return null
  }
  return (
    <span className="shrink-0 text-[10px] text-muted-foreground" data-account-agent-count>
      {count === 1
        ? translate('components.status.bar.AccountAgentCount.one', '1 terminal agent')
        : translate('components.status.bar.AccountAgentCount.other', '{{value0}} terminal agents', {
            value0: count
          })}
    </span>
  )
}
