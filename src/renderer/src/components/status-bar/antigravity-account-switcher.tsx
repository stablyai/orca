import { Trash2 } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import type {
  AntigravityAccountSummary,
  InactiveAccountUsage,
  ProviderRateLimits
} from '../../../../shared/rate-limit-types'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { barColor, clampUsedPercent } from './tooltip'

/** Compact per-account usage row for the Antigravity switcher. */
function AccountUsageRow({
  limits,
  isFetching
}: {
  limits: ProviderRateLimits | null
  isFetching: boolean
}): React.JSX.Element | null {
  if (isFetching && !limits?.session) {
    return (
      <div className="flex w-full animate-pulse items-center gap-2">
        <div className="h-[4px] flex-1 rounded-full bg-muted" />
      </div>
    )
  }
  if (!limits?.session) {
    return null
  }
  const used = clampUsedPercent(limits.session.usedPercent)
  const usedSuffix = translate('auto.components.status.bar.tooltip.cedb7b99e3', '% used')
  return (
    <div className={`flex min-w-0 items-center gap-1 ${isFetching ? 'animate-pulse' : ''}`}>
      <div className="h-[4px] min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${barColor(used)}`} style={{ width: `${used}%` }} />
      </div>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
        {used}
        {usedSuffix} {translate('auto.components.status.bar.StatusBar.d79c3362c4', '5h')}
      </span>
    </div>
  )
}

/**
 * Account switcher rendered inside the Antigravity usage popover. Lists the
 * stored Google accounts with per-account usage, lets the user switch the
 * active account (which also re-points `agy` on Windows), and capture the
 * account `agy` is currently signed into.
 */
export function AntigravityAccountSwitcher(): React.JSX.Element {
  const accounts = useAppStore((s) => s.rateLimits.antigravityAccounts)
  const inactive = useAppStore((s) => s.rateLimits.inactiveAntigravityAccounts)
  const activeUsage = useAppStore((s) => s.rateLimits.antigravity)
  const [busy, setBusy] = useState(false)
  const [manageMode, setManageMode] = useState(false)

  /** Index inactive-account usage snapshots by account id for quick row lookup. */
  const inactiveById = useMemo(() => {
    const map = new Map<string, InactiveAccountUsage>()
    for (const entry of inactive) {
      map.set(entry.accountId, entry)
    }
    return map
  }, [inactive])

  /** Run an account action behind a busy guard, logging (never throwing) on failure. */
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
    } catch (err) {
      // Why: called via `void run(...)`, so an unhandled rejection here (e.g. a
      // failed keyring write on switch) would be lost — log it and reset busy.
      console.error('Antigravity account action failed', err)
    } finally {
      setBusy(false)
    }
  }, [])

  // Why: this component mounts when the popover opens, so capture the account
  // agy is currently signed into right then — signing into a new account in agy
  // and opening this menu surfaces it immediately, without waiting for the poll.
  useEffect(() => {
    void window.api.rateLimits.refreshAntigravityAccounts().catch(() => {})
  }, [])

  /** Handle a click on an account row: remove it in manage mode, else switch to it. */
  const handleAccountAction = useCallback(
    (account: AntigravityAccountSummary) => {
      if (manageMode) {
        void run(() => window.api.rateLimits.removeAntigravityAccount(account.id))
      } else if (!account.isActive) {
        void run(() => window.api.rateLimits.selectAntigravityAccount(account.id))
      }
    },
    [manageMode, run]
  )

  /** Toggle the switcher between switch mode and remove/manage mode. */
  const toggleManageMode = useCallback((event: Event) => {
    event.preventDefault()
    setManageMode((value) => !value)
  }, [])

  return (
    <div>
      {accounts.length > 0 ? (
        <div className="px-2 py-1 text-[10px] font-medium uppercase text-muted-foreground">
          {translate('auto.components.status.bar.StatusBar.a051e38c9a', 'Accounts')}
        </div>
      ) : null}
      {accounts.map((account) => {
        const inactiveUsage = inactiveById.get(account.id)
        // The active account's usage is the main meter state; inactive accounts
        // carry their own per-account snapshot.
        const usageLimits = account.isActive ? activeUsage : (inactiveUsage?.rateLimits ?? null)
        const isFetching = account.isActive
          ? activeUsage?.status === 'fetching'
          : Boolean(inactiveUsage?.isFetching)
        return (
          <DropdownMenuItem
            key={account.id}
            disabled={busy || (!manageMode && account.isActive)}
            onSelect={(event) => {
              event.preventDefault()
              handleAccountAction(account)
            }}
          >
            <div className="flex w-full flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-2">
                <AgentIcon agent="antigravity" size={12} />
                <span className="min-w-0 flex-1 truncate">{account.email}</span>
                {manageMode ? (
                  <Trash2 size={12} className="shrink-0 text-muted-foreground" />
                ) : account.isActive ? (
                  <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                    {translate('auto.components.status.bar.StatusBar.ff0fbe9311', 'Active')}
                  </span>
                ) : null}
              </div>
              {!manageMode ? (
                <AccountUsageRow limits={usageLimits} isFetching={isFetching} />
              ) : null}
            </div>
          </DropdownMenuItem>
        )
      })}
      {accounts.length > 0 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={busy} onSelect={toggleManageMode}>
            <Trash2 size={12} className="text-muted-foreground" />
            {manageMode
              ? translate('auto.components.status.bar.StatusBar.137d65696b', 'Done')
              : translate('auto.components.status.bar.StatusBar.87a19bd15f', 'Manage accounts')}
          </DropdownMenuItem>
        </>
      ) : null}
      {manageMode ? (
        <div className="px-2 py-1 text-[10px] leading-4 text-muted-foreground">
          {translate(
            'auto.components.status.bar.StatusBar.73759b7e83',
            'Removing an account only removes it from Orca; sign out in agy to fully disconnect it.'
          )}
        </div>
      ) : (
        <div className="px-2 py-1 text-[10px] leading-4 text-muted-foreground">
          {translate(
            'auto.components.status.bar.StatusBar.1298e2427b',
            'Sign in to another Google account in agy to add it here.'
          )}
        </div>
      )}
    </div>
  )
}
