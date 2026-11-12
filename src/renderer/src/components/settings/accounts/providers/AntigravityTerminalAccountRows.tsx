import { AlertCircle, RefreshCw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { AntigravityAccountState } from '../../../../../../shared/antigravity-account-types'
import type { ProviderRateLimits } from '../../../../../../shared/rate-limit-types'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import { formatTimeAgo } from '../../../status-bar/tooltip'
import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'

export type AntigravityAccountAction = 'List' | 'AddCurrent' | 'Select' | 'Remove' | 'Usage'

export function formatUsageReading(usage: ProviderRateLimits, t: Translate = translate): string {
  return t('accounts.antigravity.usageReading', 'Session: {{session}} · Weekly: {{weekly}}', {
    session: usage.session ? `${Math.round(usage.session.usedPercent)}%` : '—',
    weekly: usage.weekly ? `${Math.round(usage.weekly.usedPercent)}%` : '—'
  })
}

/** The agy terminal card's rows: the current native login, then saved accounts. */
export function AntigravityTerminalAccountRows({
  state,
  usage,
  error,
  busy,
  windowsHost,
  run
}: {
  state: AntigravityAccountState | null
  usage: ProviderRateLimits | null
  error: string | null
  busy: boolean
  windowsHost: boolean
  run: (action: AntigravityAccountAction, accountId?: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const changed = Boolean(
    state?.selectedAccountId && state.activeAccountId !== state.selectedAccountId
  )
  const changedText = windowsHost
    ? t(
        'accounts.antigravity.windowsChanged',
        'The host default account changed. Select a saved account to apply it again.'
      )
    : t(
        'accounts.antigravity.changed',
        'The native account changed. Select a saved account again before launching agy.'
      )
  const usageButton = (savedUsage?: ProviderRateLimits | null) => {
    const reading = usage ?? savedUsage
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            aria-label={t('accounts.antigravity.usage', 'Refresh usage')}
            disabled={busy}
            onClick={() => run('Usage')}
          >
            <RefreshCw />
            {reading && !reading.error
              ? formatUsageReading(reading, t)
              : t('accounts.antigravity.usage', 'Refresh usage')}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {t('accounts.antigravity.usage', 'Refresh usage')}
        </TooltipContent>
      </Tooltip>
    )
  }
  const usageError = usage?.error ? <span className="text-destructive">{usage.error}</span> : null

  const terminalRows: React.ReactNode[] = []
  if (error) {
    terminalRows.push(
      state ? (
        <AntigravityAccountRow key="error" title={null} detail={<ActionError message={error} />} />
      ) : (
        <AntigravityAccountRow
          key="error"
          title={t('accounts.antigravity.loadFailed', "Couldn't load agy accounts")}
          detail={<ActionError message={error} />}
          actions={
            <Button size="xs" variant="outline" disabled={busy} onClick={() => run('List')}>
              {t('accounts.antigravity.retry', 'Retry')}
            </Button>
          }
        />
      )
    )
  } else if (!state) {
    terminalRows.push(
      <AntigravityAccountRow
        key="loading"
        title={t('accounts.antigravity.loading', 'Loading accounts…')}
      />
    )
  }
  if (state && !state.currentAccount) {
    terminalRows.push(
      <AntigravityAccountRow
        key="signed-out"
        title={t('accounts.antigravity.notSignedIn', 'Not signed in')}
        detail={
          <>
            <span>
              {t('accounts.antigravity.runAgy', 'Run agy on this host to sign in')}
              {' · '}
              <a
                className="text-foreground underline underline-offset-2"
                href="https://antigravity.google/docs/cli/install/"
                target="_blank"
                onClick={openAppHttpLinkFromAnchor}
                rel="noopener noreferrer"
              >
                {t('accounts.antigravity.signInHelp', 'Sign-in help')}
              </a>
            </span>
            {changed ? <span className="text-status-warning-text">{changedText}</span> : null}
          </>
        }
      />
    )
  } else if (state?.currentAccount && !state.activeAccountId) {
    const { email } = state.currentAccount
    terminalRows.push(
      <AntigravityAccountRow
        key="current"
        title={email ?? t('accounts.antigravity.currentLogin', 'Current agy login')}
        active
        detail={
          usageError ??
          (changed ? (
            <span className="text-status-warning-text">{changedText}</span>
          ) : email ? (
            t('accounts.antigravity.currentNotSaved', 'Current agy login · not saved')
          ) : (
            t('accounts.antigravity.noEmailNotSaved', "agy didn't report an email · not saved")
          ))
        }
        actions={
          <>
            {usageButton()}
            <Button size="xs" variant="outline" disabled={busy} onClick={() => run('AddCurrent')}>
              {t('accounts.antigravity.saveShort', 'Save')}
            </Button>
          </>
        }
      />
    )
  }
  for (const account of state?.accounts ?? []) {
    const active = state?.activeAccountId === account.id
    const removable = !active && state?.selectedAccountId !== account.id
    const reading =
      account.usage === undefined
        ? null
        : account.usage
          ? active
            ? t('accounts.antigravity.readAt', 'Read {{time}}', {
                time: formatTimeAgo(account.usage.updatedAt, t)
              })
            : t('accounts.antigravity.lastReading', '{{reading}} · Read {{time}}', {
                reading: formatUsageReading(account.usage, t),
                time: formatTimeAgo(account.usage.updatedAt, t)
              })
          : t('accounts.antigravity.noReading', 'Usage unknown: not read yet')
    terminalRows.push(
      <AntigravityAccountRow
        key={account.id}
        title={account.email ?? t('accounts.antigravity.saved', 'Saved Google account')}
        active={active}
        detail={(active ? usageError : null) ?? reading}
        selectDisabled={busy}
        onSelect={() => run('Select', account.id)}
        actions={
          active ? (
            usageButton(account.usage)
          ) : removable ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => run('Remove', account.id)}
            >
              <Trash2 />
              {t('accounts.antigravity.remove', 'Remove')}
            </Button>
          ) : null
        }
      />
    )
  }
  return <>{terminalRows}</>
}

function ActionError({ message }: { message: string }): React.JSX.Element {
  return (
    <span role="alert" className="flex items-center gap-1.5 text-destructive">
      <AlertCircle className="size-3.5 shrink-0" />
      {message}
    </span>
  )
}

/** A settings row whose label selects the account, like Codex's account rows. */
function AntigravityAccountRow({
  title,
  detail,
  active = false,
  actions,
  onSelect,
  selectDisabled
}: {
  title: string | null
  detail?: React.ReactNode
  active?: boolean
  actions?: React.ReactNode
  onSelect?: () => void
  selectDisabled?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const label = (
    <>
      {title ? (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {active ? (
            <Badge variant="outline">{t('accounts.antigravity.active', 'Active')}</Badge>
          ) : null}
        </span>
      ) : null}
      {detail ? (
        <span
          className={cn(
            'flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground',
            title && 'mt-0.5'
          )}
        >
          {detail}
        </span>
      ) : null}
    </>
  )
  return (
    <div data-settings-row="">
      <div
        className={cn(
          '-mx-5 flex min-h-14 items-center justify-between gap-4 px-5 py-3',
          onSelect && !selectDisabled && 'transition-colors hover:bg-accent/40'
        )}
      >
        {onSelect ? (
          <button
            type="button"
            onClick={onSelect}
            disabled={selectDisabled}
            className="flex min-w-0 flex-1 flex-col items-start text-left disabled:cursor-default"
          >
            {label}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col items-start">{label}</div>
        )}
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
    </div>
  )
}
