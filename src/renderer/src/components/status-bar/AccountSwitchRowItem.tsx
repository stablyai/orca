import { Check, Loader2, RefreshCw } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { formatResetDuration } from '../../../../shared/rate-limit-reset-format'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { splitEmailForDisplay, type AccountSwitchListEntry } from './account-switch-row-model'
import { barColor } from './provider-extra-usage-section'
import { formatBareUsagePercentage } from './usage-percentage-label'

export type AccountSwitchSignIn = {
  isSigningIn: boolean
  disabled: boolean
  onSignIn: () => void
  /** Radix selects the row on pointerup; callers use this to swallow that select. */
  onPointerDown?: () => void
}

export type AccountSwitchListRow = AccountSwitchListEntry & {
  /** Full one-line label, for the native tooltip on truncated rows. */
  title: string
  active: boolean
  disabled: boolean
  /** Usage is loading and nothing is cached yet. */
  isFetching: boolean
  /** Replaces the usage cell when no usage can be shown. */
  statusLabel: string | null
  /** A second line, reserved for rows that need attention. */
  hint: string | null
  signIn: AccountSwitchSignIn | null
  onSelect: () => void
}

export function selectAccountSwitchRow(row: AccountSwitchListRow): void {
  if (row.disabled) {
    return
  }
  if (row.signIn) {
    if (!row.signIn.disabled) {
      row.signIn.onSignIn()
    }
  } else if (!row.active) {
    row.onSelect()
  }
}

function UsageCell({
  row,
  display,
  now
}: {
  row: AccountSwitchListRow
  display: UsagePercentageDisplay
  now: number
}): React.JSX.Element | null {
  if (row.signIn) {
    const { signIn } = row
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={signIn.disabled}
        className="-my-1 shrink-0"
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
          signIn.onPointerDown?.()
        }}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          signIn.onSignIn()
        }}
      >
        {signIn.isSigningIn ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        {translate('auto.components.status.bar.StatusBar.c35af53b73', 'Sign in')}
      </Button>
    )
  }
  if (row.usage.kind === 'plan-limit') {
    if (row.usage.extraUsageAvailable) {
      return (
        <span className="shrink-0 text-2xs text-muted-foreground">
          {translate(
            'auto.components.status.bar.AccountSwitchList.extraUsageAvailable',
            'Extra usage available'
          )}
        </span>
      )
    }
    const reset = row.usage.resetsAt != null ? formatResetDuration(row.usage.resetsAt - now) : null
    return (
      <span className="shrink-0 text-2xs whitespace-nowrap text-muted-foreground tabular-nums">
        <span className="font-medium text-destructive">
          {translate(
            'auto.components.status.bar.AccountSwitchList.planLimit',
            'Plan limit reached'
          )}
        </span>
        {reset ? ` · ${reset}` : null}
      </span>
    )
  }
  if (row.usage.kind === 'usage') {
    const used = row.usage.usedPercent
    return (
      <span className="flex shrink-0 items-center gap-2">
        <span className="h-1 w-14 overflow-hidden rounded-full bg-muted">
          <span
            className={cn('block h-full rounded-full', barColor(used))}
            style={{ width: `${Math.max(getDisplayedUsagePercentage(used, display), 2)}%` }}
          />
        </span>
        <span className="w-9 text-right text-2xs text-foreground tabular-nums">
          {formatBareUsagePercentage(used, display)}
        </span>
      </span>
    )
  }
  if (row.isFetching) {
    return <span className="h-1 w-14 shrink-0 animate-pulse rounded-full bg-muted" />
  }
  if (row.statusLabel) {
    return (
      <span className="max-w-[45%] shrink truncate text-right text-2xs text-muted-foreground">
        {row.statusLabel}
      </span>
    )
  }
  return null
}

export function AccountSwitchRowItem({
  row,
  prevailingWorkspace,
  sharesEmail,
  display,
  now
}: {
  row: AccountSwitchListRow
  prevailingWorkspace: string | null
  /** Another row has the same email, so its workspace is what tells them apart. */
  sharesEmail: boolean
  display: UsagePercentageDisplay
  now: number
}): React.JSX.Element {
  const address = row.email ? splitEmailForDisplay(row.email) : null
  // Workspace only appears when it tells this row apart from the others.
  const workspaceChip =
    row.email && row.workspace && (sharesEmail || row.workspace !== prevailingWorkspace)
      ? row.workspace
      : null
  const dimmed = !row.active && row.needsSignIn

  return (
    <DropdownMenuItem
      title={row.title}
      disabled={row.disabled}
      aria-current={row.active ? 'true' : undefined}
      data-current={row.active ? 'true' : undefined}
      className="min-h-7"
      onSelect={(event) => {
        // Why: keep the menu open so the follow-up restart prompt stays in this interaction.
        event.preventDefault()
        selectAccountSwitchRow(row)
      }}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 text-xs">
        <span className="flex w-4 shrink-0 justify-center">
          {row.active ? (
            <>
              <Check className="size-3.5 text-foreground" />
              <span className="sr-only">
                {translate('auto.components.status.bar.StatusBar.ff0fbe9311', 'Active')}
              </span>
            </>
          ) : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate">
              {address ? (
                <>
                  <span
                    className={cn(
                      dimmed ? 'text-muted-foreground' : 'text-foreground',
                      row.active && 'font-medium'
                    )}
                  >
                    {address.local}
                  </span>
                  <span className="text-muted-foreground">{address.domain}</span>
                </>
              ) : (
                <span className={cn('text-foreground', row.active && 'font-medium')}>
                  {translate('auto.components.status.bar.StatusBar.c676918adc', 'System default')}
                </span>
              )}
            </span>
            {!row.email && row.systemDefaultEmail ? (
              <span className="min-w-0 truncate text-2xs text-muted-foreground">
                {row.systemDefaultEmail}
              </span>
            ) : null}
            {workspaceChip ? <AccountChip>{workspaceChip}</AccountChip> : null}
            {row.identifier ? <AccountChip>{row.identifier}</AccountChip> : null}
          </span>
          {row.hint ? (
            <span className="truncate text-3xs leading-4 text-muted-foreground">{row.hint}</span>
          ) : null}
        </span>
        <UsageCell row={row} display={display} now={now} />
      </span>
    </DropdownMenuItem>
  )
}

function AccountChip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="max-w-24 shrink-0 truncate rounded-sm bg-muted px-1 text-3xs leading-4 text-muted-foreground tabular-nums">
      {children}
    </span>
  )
}
