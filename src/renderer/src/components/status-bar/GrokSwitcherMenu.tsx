import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useGrokManagedAccounts } from '@/hooks/useGrokManagedAccounts'
import { translate } from '@/i18n/i18n'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { useAppStore } from '../../store'
import { InlineUsageBars } from './InlineProviderUsage'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'

export function GrokSwitcherMenu({
  grok,
  compact,
  iconOnly,
  asSubmenu = false,
  triggerContent
}: {
  grok: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [accountsExpanded, setAccountsExpanded] = useState(false)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const hasRemoteRuntime = useAppStore((s) =>
    Boolean(s.settings?.activeRuntimeEnvironmentId?.trim())
  )
  const localAccounts = !hasRemoteRuntime && !isPairedWebClientWindow()
  const { state, loading, busy, error, run } = useGrokManagedAccounts({
    enabled: open && localAccounts,
    updatedAt: grok.updatedAt
  })
  const systemLabel = translate('auto.components.status.bar.StatusBar.c676918adc', 'System default')
  const activeAccount = state?.accounts.find((account) => account.id === state.activeAccountId)
  const targets = state
    ? [
        { id: null, label: systemLabel, usage: state.activeAccountId === null ? grok : null },
        ...state.accounts.map((account) => ({
          id: account.id,
          label: account.email,
          usage: state.usage[account.id]
        }))
      ]
    : []

  return (
    <ProviderDetailsMenu
      provider={grok}
      compact={compact}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      ariaLabel={translate('grokAccounts.openSwitcher', 'Open Grok details and account switcher')}
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) {
          setAccountsExpanded(false)
        }
      }}
    >
      {localAccounts ? (
        <>
          <DropdownMenuLabel>
            {translate('grokAccounts.accountLabel', 'Grok Account')}
          </DropdownMenuLabel>
          <DropdownMenuItem
            disabled={busy || !state}
            onSelect={(event) => {
              event.preventDefault()
              setAccountsExpanded((expanded) => !expanded)
            }}
          >
            <span className="min-w-0 flex-1 truncate text-[12px]">
              {state
                ? (activeAccount?.email ?? systemLabel)
                : translate('grokAccounts.loadingAccounts', 'Loading accounts…')}
            </span>
            {loading || busy ? (
              <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" />
            ) : accountsExpanded ? (
              <ChevronDown className="ml-auto size-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />
            )}
          </DropdownMenuItem>
          {accountsExpanded ? (
            <div className="px-1 pb-1">
              <div className="max-h-[220px] overflow-y-auto rounded-md border border-border/60 bg-accent/5 p-1 scrollbar-sleek">
                {targets.map((target) => (
                  <DropdownMenuItem
                    key={target.id ?? 'system'}
                    data-grok-account-id={target.id ?? 'system'}
                    disabled={busy || target.id === state?.activeAccountId}
                    onSelect={(event) => {
                      event.preventDefault()
                      void run(() => window.api.grokAccounts.select(target.id))
                    }}
                  >
                    <div className="flex w-full min-w-0 flex-col gap-0.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 whitespace-normal break-words">
                          {target.label}
                        </span>
                        {target.id === state?.activeAccountId ? (
                          <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                            {translate('auto.components.status.bar.StatusBar.ff0fbe9311', 'Active')}
                          </span>
                        ) : null}
                      </div>
                      {target.usage ? (
                        <InlineUsageBars limits={target.usage} isFetching={loading} />
                      ) : null}
                    </div>
                  </DropdownMenuItem>
                ))}
              </div>
            </div>
          ) : null}
          <p className="px-2 pb-2 text-[11px] text-muted-foreground">
            {translate(
              'grokAccounts.launchHint',
              'Choose the account for new Grok sessions on this computer. Existing sessions keep their own account.'
            )}
          </p>
          {error ? (
            <p role="alert" className="px-2 pb-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          {translate('grokAccounts.hostOnly', 'Manage Grok accounts on the computer running Orca.')}
        </p>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: 'accounts-grok' })
          openSettingsPage()
        }}
      >
        {translate('auto.components.status.bar.StatusBar.75ded02687', 'Manage Accounts…')}
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}
