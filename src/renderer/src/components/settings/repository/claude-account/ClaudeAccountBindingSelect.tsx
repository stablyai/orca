import { useId } from 'react'
import type { ClaudeAccountBinding } from '../../../../../../shared/agent-accounts/claude/claude-account-binding'
import type { ClaudeManagedAccountSummary } from '../../../../../../shared/agent-accounts/managed-account-types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { useTranslate } from '@/i18n/use-translate'

// Radix forbids empty item values.
const UNBOUND_VALUE = '__unbound__'
const PICK_FOLDER_VALUE = '__pick_folder__'
const FOLDER_PREFIX = 'folder:'
const ACCOUNT_PREFIX = 'account:'

function bindingValue(binding: ClaudeAccountBinding | undefined): string {
  if (!binding) {
    return UNBOUND_VALUE
  }
  return binding.kind === 'managed'
    ? `${ACCOUNT_PREFIX}${binding.accountId}`
    : `${FOLDER_PREFIX}${binding.configDir}`
}

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
  const current = bindingValue(binding)
  const accountMissing =
    binding?.kind === 'managed' && !accounts.some((account) => account.id === binding.accountId)

  const onValueChange = async (value: string) => {
    if (value === current) {
      return
    }
    if (value === UNBOUND_VALUE) {
      onChange(null)
    } else if (value === PICK_FOLDER_VALUE) {
      const configDir = await window.api.shell.pickDirectory(
        binding?.kind === 'folder' ? { defaultPath: binding.configDir } : {}
      )
      if (configDir) {
        onChange({ kind: 'folder', configDir })
      }
    } else if (value.startsWith(ACCOUNT_PREFIX)) {
      onChange({ kind: 'managed', accountId: value.slice(ACCOUNT_PREFIX.length) })
    }
  }

  return (
    <div className="space-y-1.5">
      <span id={labelId} className="text-xs text-muted-foreground">
        {label}
      </span>
      <Select value={current} disabled={disabled} onValueChange={(v) => void onValueChange(v)}>
        <SelectTrigger size="sm" className="w-full" aria-labelledby={labelId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNBOUND_VALUE}>{unboundLabel}</SelectItem>
          {accountMissing ? (
            <SelectItem value={current} disabled>
              {t(
                'auto.components.settings.RepositoryClaudeAccountSection.missingAccount',
                'Removed account'
              )}
            </SelectItem>
          ) : null}
          {accounts.map((account) => (
            <SelectItem key={account.id} value={`${ACCOUNT_PREFIX}${account.id}`}>
              {account.displayName ?? account.email}
            </SelectItem>
          ))}
          {binding?.kind === 'folder' ? (
            <SelectItem value={current}>{binding.configDir}</SelectItem>
          ) : null}
          <SelectItem value={PICK_FOLDER_VALUE}>
            {t(
              'auto.components.settings.RepositoryClaudeAccountSection.pickFolder',
              'Choose a config folder…'
            )}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
