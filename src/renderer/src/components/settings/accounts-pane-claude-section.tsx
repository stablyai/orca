import { Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { selectClaudeProviderAccount } from '@/runtime/runtime-provider-accounts-client'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { ClaudeIcon } from '../status-bar/icons'
import { SearchableSetting } from './SearchableSetting'
import {
  getProviderAccountRuntime,
  providerAccountIsActiveInView
} from './provider-account-visibility'
import { formatAccountTimestamp, getClaudeAccountRuntimeLabel } from './accounts-pane-runtime'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

export function renderClaudeAccountsSection(model: AccountsPaneSectionModel): React.JSX.Element {
  const {
    accountRuntime,
    accountRuntimeSentenceLabel,
    accountRuntimeUnavailable,
    accountVisibilityOptions,
    claudeAccounts,
    claudeAction,
    isRemoteAccountScope,
    remoteAccountScopeNotice,
    runClaudeAccountAction,
    setRemoveClaudeTarget,
    settings,
    systemClaudeActive,
    visibleClaudeAccounts,
    wslCapabilitiesLoading
  } = model
  return (
    <section key="claude-accounts" id="accounts-claude" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ClaudeIcon size={16} />
          {translate('auto.components.settings.AccountsPane.26ef4b55be', 'Claude')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AccountsPane.72b36ea174',
            'Optional. Orca can use your normal Claude login; add accounts only if you want quick switching without moving chat sessions.'
          )}
        </p>
      </div>

      <SearchableSetting
        title={translate('auto.components.settings.AccountsPane.8bbfd74556', 'Claude Accounts')}
        description={translate(
          'auto.components.settings.AccountsPane.79e484c3b2',
          'Optional account switcher for the shared Claude auth files.'
        )}
        keywords={['claude', 'account', 'rate limit', 'status bar', 'quota']}
        className="space-y-3 py-2"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label>
              {translate('auto.components.settings.AccountsPane.94d351af4a', 'Accounts')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {isRemoteAccountScope
                ? translate(
                    'auto.components.settings.AccountsPane.remoteScopeAccounts',
                    'Showing accounts managed by {{value0}}. Add or re-authenticate accounts on that server.',
                    { value0: accountRuntimeSentenceLabel }
                  )
                : translate(
                    'auto.components.settings.AccountsPane.c0a52abfc5',
                    'Showing accounts for {{value0}}. New accounts are added there.',
                    { value0: accountRuntimeSentenceLabel }
                  )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                void runClaudeAccountAction('adding', () =>
                  window.api.claudeAccounts.add({
                    runtime: accountRuntime.runtime,
                    wslDistro: accountRuntime.wslDistro
                  })
                )
              }
              disabled={
                // Why: interactive `claude login` needs a desktop browser and
                // would authenticate against this device, not the server.
                isRemoteAccountScope ||
                claudeAction !== 'idle' ||
                wslCapabilitiesLoading ||
                accountRuntimeUnavailable
              }
              className="gap-1.5"
            >
              {claudeAction === 'adding' ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Plus className="size-3" />
              )}
              {translate('auto.components.settings.AccountsPane.b0e948a4f9', 'Add Account')}
            </Button>
            {claudeAction === 'adding' ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void window.api.claudeAccounts.cancelPendingLogin()}
                className="gap-1.5 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
                {translate('auto.components.settings.AccountsPane.dbb9626ed1', 'Cancel')}
              </Button>
            ) : null}
          </div>
        </div>
        {remoteAccountScopeNotice}

        <div className="space-y-2">
          <button
            type="button"
            onClick={() =>
              void runClaudeAccountAction('select:system', () =>
                selectClaudeProviderAccount(settings, {
                  accountId: null,
                  runtime: accountRuntime.runtime,
                  wslDistro: accountRuntime.wslDistro
                })
              )
            }
            disabled={claudeAction !== 'idle' || accountRuntimeUnavailable}
            className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
              systemClaudeActive
                ? 'border-foreground/20 bg-accent/15'
                : 'border-border/70 hover:border-border hover:bg-accent/8'
            } disabled:cursor-default disabled:opacity-100`}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {translate('auto.components.settings.AccountsPane.f2a265f8c7', 'System default')}
                </span>
                {systemClaudeActive ? (
                  <Badge
                    variant="outline"
                    className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
                  >
                    {translate('auto.components.settings.AccountsPane.e74831fb6b', 'Active')}
                  </Badge>
                ) : null}
              </div>
              <span className="truncate text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.settings.AccountsPane.e05d0ff737',
                  'Use your current {{value0}} Claude login.',
                  { value0: accountRuntimeSentenceLabel }
                )}
              </span>
            </div>
          </button>
          {visibleClaudeAccounts.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
              {isRemoteAccountScope
                ? translate(
                    'auto.components.settings.AccountsPane.remoteEmptyClaudeAccounts',
                    'No managed Claude accounts on {{value0}}. It uses its system default Claude login; add accounts on that server.',
                    { value0: accountRuntimeSentenceLabel }
                  )
                : translate(
                    'auto.components.settings.AccountsPane.3fe7862418',
                    "No managed Claude accounts for {{value0}}. Orca will use that environment's system default Claude login until you add one here.",
                    { value0: accountRuntimeSentenceLabel }
                  )}
            </div>
          ) : (
            visibleClaudeAccounts.map((account) => {
              const isActive = providerAccountIsActiveInView(
                account,
                claudeAccounts,
                accountRuntime,
                accountVisibilityOptions
              )
              const isReauthing = claudeAction === `reauth:${account.id}`
              const isBusy = claudeAction !== 'idle' || accountRuntimeUnavailable

              return (
                <div
                  key={account.id}
                  className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                    isActive
                      ? 'border-foreground/20 bg-accent/15'
                      : 'border-border/70 hover:border-border hover:bg-accent/8'
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-3 max-md:flex-col max-md:items-start">
                    <button
                      type="button"
                      onClick={() => {
                        const accountRuntimeView = getProviderAccountRuntime(account)
                        void runClaudeAccountAction(
                          `select:${account.id}`,
                          () =>
                            selectClaudeProviderAccount(settings, {
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
                          {getClaudeAccountRuntimeLabel(account, accountRuntime.label)}
                        </Badge>
                        {isActive ? (
                          <Badge
                            variant="outline"
                            className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
                          >
                            {translate(
                              'auto.components.settings.AccountsPane.e74831fb6b',
                              'Active'
                            )}
                          </Badge>
                        ) : null}
                      </div>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {account.organizationName
                          ? `${account.organizationName} · ${formatAccountTimestamp(account.lastAuthenticatedAt)}`
                          : formatAccountTimestamp(account.lastAuthenticatedAt)}
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center justify-end gap-1 max-md:w-full max-md:flex-wrap">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={(event) => {
                          event.stopPropagation()
                          void runClaudeAccountAction(
                            `reauth:${account.id}`,
                            () =>
                              window.api.claudeAccounts.reauthenticate({
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
                        {translate(
                          'auto.components.settings.AccountsPane.8a0f870153',
                          'Re-authenticate'
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={(event) => {
                          event.stopPropagation()
                          setRemoveClaudeTarget({
                            id: account.id,
                            runtime: getProviderAccountRuntime(account)
                          })
                        }}
                        disabled={isBusy}
                        className="h-6 px-2 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-3" />
                        {translate('auto.components.settings.AccountsPane.db209ee572', 'Remove')}
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </SearchableSetting>
    </section>
  )
}
