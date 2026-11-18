import { WorkspaceAccountOptions } from './WorkspaceAccountOptions'
import { getCodexAccountDisplayLabel } from '../../../../../../shared/agent-accounts/codex-account-display-label'
import type { CodexManagedAccountSummary } from '../../../../../../shared/agent-accounts/managed-account-types'

export function WorkspaceCodexAccountOptions(props: {
  accounts: CodexManagedAccountSummary[]
  selectedId?: string
  loading: boolean
  saving: boolean
  error: string | null
  onSelect: (value: string) => void
}) {
  return (
    <WorkspaceAccountOptions
      {...props}
      provider="Codex"
      accounts={props.accounts.map((account) => ({
        id: account.id,
        label: getCodexAccountDisplayLabel(account, props.accounts)
      }))}
    />
  )
}
