import type { Repo } from '../../../../shared/repo-types'
import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'
import type { ProjectClaudeAccountPreference } from '../../../../shared/claude/project-claude-account-preference'
import { translate } from '@/i18n/i18n'

export const DEFAULT_VALUE = '__default__'
export const ASK_VALUE = '__ask__'

export type ClaudeAccountOption = {
  value: string
  label: string
  disabled?: boolean
}

export function claudeAccountLabel(account: ClaudeManagedAccountSummary): string {
  return account.organizationName ? `${account.email} · ${account.organizationName}` : account.email
}

export function buildClaudeAccountOptions(input: {
  accounts: ClaudeManagedAccountSummary[]
  saved?: ProjectClaudeAccountPreference
}): ClaudeAccountOption[] {
  const options: ClaudeAccountOption[] = [
    {
      value: DEFAULT_VALUE,
      label: translate('auto.components.settings.RepositoryClaudeAccountSection.default', 'Default')
    },
    {
      value: ASK_VALUE,
      label: translate(
        'auto.components.settings.RepositoryClaudeAccountSection.ask',
        'Ask every time'
      )
    },
    ...input.accounts.map((account) => ({
      value: account.id,
      label: claudeAccountLabel(account)
    }))
  ]

  const saved = input.saved
  if (
    saved?.mode === 'account' &&
    !input.accounts.some((account) => account.id === saved.accountId)
  ) {
    options.push({
      value: saved.accountId,
      label: translate(
        'auto.components.settings.RepositoryClaudeAccountSection.removedAccountOption',
        'Removed account (unavailable)'
      ),
      disabled: true
    })
  }

  return options
}

// Why: SSH repos spawn Claude on a remote host that never sees the local managed-account store.
export function claudeAccountPinningUnsupportedReason(repo: Repo): 'ssh' | null {
  return repo.connectionId ? 'ssh' : null
}
