import { useId } from 'react'
import type { ClaudeAccountBinding } from '../../../../../../shared/agent-accounts/claude/claude-account-binding'
import type { ClaudeManagedAccountSummary } from '../../../../../../shared/agent-accounts/managed-account-types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { useTranslate } from '@/i18n/use-translate'
import {
  claudeAccountOptionValue,
  claudeBindingFromValue,
  claudeBindingValue,
  UNBOUND_BINDING_VALUE
} from './claude-account-binding-options'

type ClaudeAccountBindingSelectProps = {
  label: string
  /** What an unbound owner does instead, e.g. follow the selection or its group. */
  unboundLabel: string
  binding: ClaudeAccountBinding | undefined
  accounts: readonly ClaudeManagedAccountSummary[]
  disabled: boolean
  onChange: (binding: ClaudeAccountBinding | null) => void
}

export function ClaudeAccountBindingSelect({
  label,
  unboundLabel,
  binding,
  accounts,
  disabled,
  onChange
}: ClaudeAccountBindingSelectProps): React.JSX.Element {
  const t = useTranslate()
  const labelId = useId()
  const current = claudeBindingValue(binding)
  const accountMissing =
    binding?.kind === 'managed' && !accounts.some((account) => account.id === binding.accountId)

  const onValueChange = (value: string) => {
    if (value === current) {
      return
    }
    const next = claudeBindingFromValue(value)
    if (next !== undefined) {
      onChange(next)
    }
  }

  return (
    <div className="space-y-1.5">
      <span id={labelId} className="text-xs text-muted-foreground">
        {label}
      </span>
      <Select value={current} disabled={disabled} onValueChange={onValueChange}>
        <SelectTrigger size="sm" className="w-full" aria-labelledby={labelId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNBOUND_BINDING_VALUE}>{unboundLabel}</SelectItem>
          {accountMissing ? (
            <SelectItem value={current} disabled>
              {t(
                'auto.components.settings.RepositoryClaudeAccountSection.missingAccount',
                'Removed account'
              )}
            </SelectItem>
          ) : null}
          {accounts.map((account) => (
            <SelectItem key={account.id} value={claudeAccountOptionValue(account.id)}>
              {account.displayName ?? account.email}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
