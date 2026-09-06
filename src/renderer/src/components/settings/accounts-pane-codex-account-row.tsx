import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import type { CodexRateLimitAccountsState } from '../../../../shared/managed-account-types'
import { translate } from '@/i18n/i18n'
import { selectCodexProviderAccount } from '@/runtime/runtime-provider-accounts-client'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { getCodexAccountAuthWarning } from './codex-account-auth-warning'
import {
  getProviderAccountRuntime,
  providerAccountIsActiveInView
} from './provider-account-visibility'
import { formatAccountTimestamp, getCodexAccountRuntimeLabel } from './accounts-pane-runtime'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

export function renderCodexAccountRow(
  account: CodexRateLimitAccountsState['accounts'][number],
  model: AccountsPaneSectionModel
): React.JSX.Element {
  const {
    accountRuntime,
    accountRuntimeUnavailable,
    accountVisibilityOptions,
    activeCodexAccountId,
    codexAccounts,
    codexAction,
    codexRateLimits,
    codexRateLimitTarget,
    isRemoteAccountScope,
    runCodexAccountAction,
    setRemoveCodexTarget,
    settings
  } = model
  const isActive = providerAccountIsActiveInView(
    account,
    codexAccounts,
    accountRuntime,
    accountVisibilityOptions
  )
  // Why: same remote gate as the section-level warning — the
  // desktop's rate-limit poll says nothing about server accounts.
  const accountAuthWarning = isRemoteAccountScope
    ? null
    : getCodexAccountAuthWarning({
        limits: codexRateLimits,
        target: codexRateLimitTarget,
        runtime: accountRuntime,
        activeAccountId: activeCodexAccountId,
        accountId: account.id
      })
  const needsReauthentication = Boolean(accountAuthWarning)
  const isReauthing = codexAction === `reauth:${account.id}`
  const isRemoving = codexAction === `remove:${account.id}`
  const isBusy = codexAction !== 'idle' || accountRuntimeUnavailable

  return (
    <div
      key={account.id}
      className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
        needsReauthentication
          ? 'border-destructive/50 bg-destructive/5'
          : isActive
            ? 'border-foreground/20 bg-accent/15'
            : 'border-border/70 hover:border-border hover:bg-accent/8'
      }`}
    >
      <div className="flex w-full items-center justify-between gap-3 max-md:flex-col max-md:items-start">
        <button
          type="button"
          onClick={() => {
            const accountRuntimeView = getProviderAccountRuntime(account)
            void runCodexAccountAction(
              `select:${account.id}`,
              () =>
                selectCodexProviderAccount(settings, {
                  accountId: account.id,
                  ...accountRuntimeView
                }),
              accountRuntimeView
            )
          }}
          disabled={isBusy}
          className="flex min-w-0 flex-1 flex-col gap-0.5 text-left disabled:cursor-default"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{account.email}</span>
            <Badge
              variant="outline"
              className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/70"
            >
              {getCodexAccountRuntimeLabel(account, accountRuntime.label)}
            </Badge>
            {isActive ? (
              <Badge
                variant="outline"
                className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
              >
                {translate('auto.components.settings.AccountsPane.e74831fb6b', 'Active')}
              </Badge>
            ) : null}
            {needsReauthentication ? (
              <Badge
                variant="destructive"
                className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none"
              >
                {translate('auto.components.settings.AccountsPane.589eba1eee', 'Needs re-auth')}
              </Badge>
            ) : null}
          </div>
          <div
            className={`flex min-w-0 items-center gap-1.5 text-[11px] max-sm:flex-wrap ${
              needsReauthentication ? 'text-destructive' : 'text-muted-foreground'
            }`}
          >
            {needsReauthentication ? (
              <span className="truncate">
                {translate(
                  'auto.components.settings.AccountsPane.3d245ef7d9',
                  'Codex reported this sign-in is out of date'
                )}
              </span>
            ) : account.workspaceLabel ? (
              <span className="truncate">{account.workspaceLabel}</span>
            ) : null}
            {needsReauthentication || account.workspaceLabel ? (
              <span className="shrink-0 opacity-50">•</span>
            ) : null}
            <span className="shrink-0">{formatAccountTimestamp(account.lastAuthenticatedAt)}</span>
          </div>
        </button>

        <div className="flex shrink-0 items-center justify-end gap-1 max-md:w-full max-md:flex-wrap">
          {/* Why: selecting an account is the primary action in this row.
          Keeping maintenance actions visually lighter prevents re-auth/remove
          controls from overpowering the selection affordance in a dense list. */}
          <Button
            variant="ghost"
            size="xs"
            onClick={(event) => {
              event.stopPropagation()
              void runCodexAccountAction(
                `reauth:${account.id}`,
                () =>
                  window.api.codexAccounts.reauthenticate({
                    accountId: account.id
                  }),
                getProviderAccountRuntime(account)
              )
            }}
            disabled={isRemoteAccountScope || isBusy}
            className="h-6 px-2 text-muted-foreground hover:text-foreground"
          >
            {isReauthing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {translate('auto.components.settings.AccountsPane.8a0f870153', 'Re-authenticate')}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={(event) => {
              event.stopPropagation()
              setRemoveCodexTarget({
                id: account.id,
                runtime: getProviderAccountRuntime(account)
              })
            }}
            disabled={isBusy}
            className="h-6 px-2 text-muted-foreground hover:text-destructive"
          >
            {isRemoving ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3" />
            )}
            {translate('auto.components.settings.AccountsPane.db209ee572', 'Remove')}
          </Button>
        </div>
      </div>
    </div>
  )
}
