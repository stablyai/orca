import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { useIdentityRowRunAccounts } from '../../store/agent-identity-row-run-accounts'
import type { AgentRunAccountProvider } from '../../../../shared/agent-run-account'
import { countTerminalAgentsByAccount } from '../status-bar/count-terminal-agents-by-account'

const EMPTY_ROWS = {}

function noteText(provider: AgentRunAccountProvider, count: number): string {
  // Why Claude differs: its open terminals read the removed account's file, which starts nothing.
  if (provider === 'claude') {
    return count === 1
      ? translate(
          'components.settings.accountsPaneRemoval.keptClaudeAgentsOne',
          '1 terminal agent is kept on this account. After removal, Orca starts it on the selected account, but claude typed in its open terminal will not run.'
        )
      : translate(
          'components.settings.accountsPaneRemoval.keptClaudeAgentsOther',
          '{{value0}} terminal agents are kept on this account. After removal, Orca starts them on the selected account, but claude typed in their open terminals will not run.',
          { value0: count }
        )
  }
  return count === 1
    ? translate(
        'components.settings.accountsPaneRemoval.keptAgentsOne',
        '1 terminal agent is kept on this account. After removal it follows the selected account from its next start.'
      )
    : translate(
        'components.settings.accountsPaneRemoval.keptAgentsOther',
        '{{value0}} terminal agents are kept on this account. After removal they follow the selected account from their next start.',
        { value0: count }
      )
}

/** Says what removal does to agents kept on the account: they follow the selection again. */
export function KeptAgentsRemovalNote({
  provider,
  accountId,
  enabled
}: {
  provider: AgentRunAccountProvider
  accountId: string
  /** Off for another runtime's or a WSL account, whose agents this host does not see. */
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
          accountId,
          keptOnly: true
        })
      : 0
  )
  if (count === 0) {
    return null
  }
  return (
    <p className="text-sm text-muted-foreground" data-kept-agents-removal-note>
      {noteText(provider, count)}
    </p>
  )
}
