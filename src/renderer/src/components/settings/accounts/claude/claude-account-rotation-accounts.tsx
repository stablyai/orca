import { useEffect, useState } from 'react'
import type {
  ClaudeAccountRotationAccountSettings,
  ClaudeAccountRotationSettings,
  ClaudeAccountRotationStatus
} from '../../../../../../shared/agent-accounts/claude/claude-account-rotation'
import { useTranslate } from '@/i18n/use-translate'
import { Checkbox } from '../../../ui/checkbox'
import { Input } from '../../../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { rankedAccounts, withRank } from './claude-account-rotation-ranks'

/** Saves a change built from the latest value, including a save still in flight. */
export type RotationSave = (
  change: (current: ClaudeAccountRotationSettings) => Partial<ClaudeAccountRotationSettings>
) => void

const SHARED_LIMITS: ClaudeAccountRotationAccountSettings = {
  enabled: true,
  fiveHourPercent: null,
  weeklyPercent: null
}

/** An empty value means the shared limit; saved on blur like the shared ones. */
function LimitInput({
  label,
  value,
  shared,
  onCommit
}: {
  label: string
  value: number | null
  shared: number
  onCommit: (value: number | null) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value === null ? '' : String(value))
  useEffect(() => setDraft(value === null ? '' : String(value)), [value])
  const commit = (): void => {
    const parsed = Number.parseInt(draft, 10)
    const next =
      draft.trim() === '' || Number.isNaN(parsed) ? null : Math.min(100, Math.max(1, parsed))
    setDraft(next === null ? '' : String(next))
    if (next !== value) {
      onCommit(next)
    }
  }
  return (
    <div className="flex items-center gap-1 tabular-nums">
      <Input
        type="number"
        min={1}
        max={100}
        aria-label={label}
        placeholder={String(shared)}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit()
          }
        }}
        className="h-7 w-16 text-center"
      />
      <span className="text-xs text-muted-foreground">%</span>
    </div>
  )
}

export function ClaudeAccountRotationAccounts({
  status,
  rotation,
  save
}: {
  status: ClaudeAccountRotationStatus
  rotation: ClaudeAccountRotationSettings
  save: RotationSave
}): React.JSX.Element | null {
  const t = useTranslate()
  const rows: { account: string; label: string }[] = []
  for (const folder of status.folders) {
    const account = folder.claudeAccount
    if (account !== null && !rows.some((row) => row.account === account)) {
      rows.push({ account, label: folder.label ?? account })
    }
  }
  if (rows.length === 0) {
    return null
  }
  const shown = rows.map((row) => row.account)
  const ranked = rankedAccounts(rotation.preferredAccounts, shown)
  const setOwn = (account: string, patch: Partial<ClaudeAccountRotationAccountSettings>): void =>
    save((current) => ({
      accounts: {
        ...current.accounts,
        [account]: { ...SHARED_LIMITS, ...current.accounts[account], ...patch }
      }
    }))
  const head = 'px-1 pb-1 text-left text-xs font-normal text-muted-foreground'
  // Every column but the account name takes only the width its control needs.
  const fit = 'w-px whitespace-nowrap px-1 py-1'
  return (
    <div className="space-y-2 py-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {t('accounts.claude.rotation.accountsTitle', 'Accounts')}
        </p>
        <p className="select-text text-xs text-muted-foreground">
          {t(
            'accounts.claude.rotation.accountsDescription',
            'Orca never switches to or away from an account you turn off. An empty limit uses the one above. Priority 1 is used first, and Orca switches back to a higher one once its 5-hour use is under half. Accounts without a priority come last, least used first.'
          )}
        </p>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className={head}>{t('accounts.claude.rotation.columnAccount', 'Account')}</th>
            <th className={`${head} w-px whitespace-nowrap`}>
              {t('accounts.claude.rotation.columnUse', 'Use')}
            </th>
            <th className={`${head} w-px whitespace-nowrap`}>
              {t('accounts.claude.rotation.columnFiveHour', '5-hour')}
            </th>
            <th className={`${head} w-px whitespace-nowrap`}>
              {t('accounts.claude.rotation.columnWeekly', 'Weekly')}
            </th>
            <th className={`${head} w-px whitespace-nowrap`}>
              {t('accounts.claude.rotation.columnPriority', 'Priority')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ account, label }) => {
            const own = { ...SHARED_LIMITS, ...rotation.accounts[account] }
            const index = ranked.indexOf(account)
            // An unranked account can take the place right after the ranked ones, none further down.
            const places = index === -1 ? ranked.length + 1 : ranked.length
            return (
              <tr key={account}>
                <td className="max-w-0 truncate px-1 py-1" title={label}>
                  {label}
                </td>
                <td className={fit}>
                  <Checkbox
                    aria-label={t('accounts.claude.rotation.useAccount', 'Use {{account}}', {
                      account: label
                    })}
                    checked={own.enabled}
                    onCheckedChange={(checked) => setOwn(account, { enabled: checked === true })}
                  />
                </td>
                <td className={fit}>
                  <LimitInput
                    label={t('accounts.claude.rotation.fiveHourOf', '5-hour limit of {{account}}', {
                      account: label
                    })}
                    value={own.fiveHourPercent}
                    shared={rotation.fiveHourPercent}
                    onCommit={(value) => setOwn(account, { fiveHourPercent: value })}
                  />
                </td>
                <td className={fit}>
                  <LimitInput
                    label={t('accounts.claude.rotation.weeklyOf', 'Weekly limit of {{account}}', {
                      account: label
                    })}
                    value={own.weeklyPercent}
                    shared={rotation.weeklyPercent}
                    onCommit={(value) => setOwn(account, { weeklyPercent: value })}
                  />
                </td>
                <td className={fit}>
                  <Select
                    value={index === -1 ? 'none' : String(index + 1)}
                    onValueChange={(value) =>
                      save((current) => ({
                        preferredAccounts: withRank(
                          current.preferredAccounts,
                          shown,
                          account,
                          value === 'none' ? null : Number(value)
                        )
                      }))
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-[84px]"
                      aria-label={t(
                        'accounts.claude.rotation.priorityOf',
                        'Priority of {{account}}',
                        { account: label }
                      )}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: places }, (_, rank) => (
                        <SelectItem key={rank} value={String(rank + 1)}>
                          {String(rank + 1)}
                        </SelectItem>
                      ))}
                      <SelectItem value="none">
                        {t('accounts.claude.rotation.priorityNone', 'None')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
