import { useTabAgentAccounts } from './use-tab-agent-accounts'

/** The hover card's account lines: one per agent pane, in layout order. */
export function TabAgentAccountLines({ tabId }: { tabId: string }): React.JSX.Element | null {
  const accounts = useTabAgentAccounts(tabId)
  if (accounts.length === 0) {
    return null
  }
  return (
    <div className="space-y-0.5 text-muted-foreground" data-tab-hover-card-accounts>
      {accounts.map((account) => (
        <div key={account.paneKey} className="break-words">
          {accounts.length > 1 ? `${account.agentLabel} · ` : ''}
          {account.accountLabel} · {account.note}
        </div>
      ))}
    </div>
  )
}
