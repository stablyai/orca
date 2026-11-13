import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import type { ClaudeRateLimitAccountsState } from '../../../../../../shared/managed-account-types'
import { getManagedAccountPrimaryLabel } from '../../../../../../shared/managed-account-display-names'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { selectClaudeProviderAccount } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'
import { ButtonGroup } from '../../../ui/button-group'
import {
  getProviderAccountRuntime,
  providerAccountIsActiveInView
} from '../../../provider-accounts/provider-account-visibility'
import {
  formatAccountTimestamp,
  getClaudeAccountRuntimeLabel,
  joinAccountDetails
} from '../scope/accounts-pane-runtime'
import type { AccountsPaneSectionModel } from '../accounts-pane-types'
import {
  canOfferClaudeSignInLink,
  ClaudeSignInLinkMenu,
  withCopiedClaudeLink
} from './claude-sign-in-link-menu'
import { AccountRenameButton, renameTargetFor } from '../account-rename-button'

export function renderClaudeAccountRow(
  account: ClaudeRateLimitAccountsState['accounts'][number],
  model: AccountsPaneSectionModel,
  t: Translate = translate,
  intlLocale?: string
): React.JSX.Element {
  const {
    accountOwner,
    accountRuntime,
    accountRuntimeUnavailable,
    accountVisibilityOptions,
    claudeAccounts,
    claudeAction,
    isRemoteAccountScope,
    renamingAccountKeys,
    runClaudeAccountAction,
    setRemoveClaudeTarget,
    setRenameTarget
  } = model
  const isActive = providerAccountIsActiveInView(
    account,
    claudeAccounts,
    accountRuntime,
    accountVisibilityOptions
  )
  const isReauthing = claudeAction === `reauth:${account.id}`
  const isBusy = claudeAction !== 'idle' || accountRuntimeUnavailable
  const accountRuntimeView = getProviderAccountRuntime(account)
  const accountLabel = getManagedAccountPrimaryLabel(account)
  // A named row keeps its sign-in email visible, most of all when it needs signing in.
  const namedEmail = account.displayName ? account.email : null
  const reauthenticate = (copyLink: boolean): Promise<void> =>
    runClaudeAccountAction(
      `reauth:${account.id}`,
      () =>
        withCopiedClaudeLink(
          copyLink,
          window.api.claudeAccounts.reauthenticate({
            accountId: account.id,
            copyLink
          })
        ),
      accountRuntimeView
    )

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
            void runClaudeAccountAction(
              `select:${account.id}`,
              () =>
                selectClaudeProviderAccount(accountOwner, {
                  accountId: account.id,
                  ...accountRuntimeView
                }),
              accountRuntimeView
            )
          }}
          disabled={isBusy || account.needsSignIn}
          className="flex min-w-0 flex-1 flex-col gap-0.5 text-left disabled:cursor-default"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{accountLabel}</span>
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
                {t('auto.components.settings.AccountsPane.e74831fb6b', 'Active')}
              </Badge>
            ) : null}
          </div>
          <span className="truncate text-[11px] text-muted-foreground">
            {joinAccountDetails(
              account.needsSignIn
                ? [
                    namedEmail,
                    t('accounts.claude.signInRequired', 'Sign in again to use this account')
                  ]
                : [
                    account.organizationName,
                    namedEmail,
                    formatAccountTimestamp(account.lastAuthenticatedAt, intlLocale)
                  ]
            )}
          </span>
        </button>
        <div className="flex shrink-0 items-center justify-end gap-1 max-md:w-full max-md:flex-wrap">
          <AccountRenameButton
            t={t}
            disabled={claudeAction === `remove:${account.id}`}
            pending={renamingAccountKeys.has(`claude:${account.id}`)}
            onRename={() => setRenameTarget(renameTargetFor('claude', account, accountRuntimeView))}
          />
          <ButtonGroup>
            <Button
              variant="ghost"
              size="xs"
              onClick={(event) => {
                event.stopPropagation()
                void reauthenticate(false)
              }}
              disabled={isRemoteAccountScope || isBusy}
              className="h-6 px-2 text-muted-foreground hover:text-foreground"
            >
              {isReauthing ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              {t('accounts.claude.signInAgain', 'Sign in again')}
            </Button>
            {canOfferClaudeSignInLink(accountRuntimeView.runtime) ? (
              <ClaudeSignInLinkMenu
                variant="ghost"
                disabled={isRemoteAccountScope || isBusy}
                onCopyLink={() => void reauthenticate(true)}
              />
            ) : null}
          </ButtonGroup>
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
            {t('auto.components.settings.AccountsPane.db209ee572', 'Remove')}
          </Button>
        </div>
      </div>
    </div>
  )
}
