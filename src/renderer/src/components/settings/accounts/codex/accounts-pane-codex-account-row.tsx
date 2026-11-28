import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import type { CodexRateLimitAccountsState } from '../../../../../../shared/agent-accounts/managed-account-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { getCodexAccountDisplayDetail } from '../../../../../../shared/agent-accounts/codex-account-display-label'
import { selectCodexProviderAccount } from '@/runtime/provider-accounts/observations/runtime-provider-account-selection'
import { signInCodexAccountOnHost } from '@/runtime/provider-accounts/sign-in/runtime-host-account-sign-in-client'
import { Button } from '../../../ui/button'
import { getCodexAccountAuthWarning } from '../../../../../../shared/agent-accounts/codex/codex-account-auth-warning'
import {
  getProviderAccountRuntime,
  providerAccountIsActiveInView
} from '../../../provider-accounts/provider-account-visibility'
import { formatAccountTimestamp, getCodexAccountRuntimeLabel } from '../scope/accounts-pane-runtime'
import type { AccountsPaneSectionModel } from '../accounts-pane-types'
import { getManagedAccountPrimaryLabel } from '../../../../../../shared/agent-accounts/managed-account-display-names'
import { AccountRenameButton, renameTargetFor } from '../account-rename-button'
import { AccountCard, AccountCardTag } from '../account-card'
import { getObservedCodexAccountPlan } from '@/lib/provider-accounts/observed-account-plans'

export function renderCodexAccountRow(
  account: CodexRateLimitAccountsState['accounts'][number],
  model: AccountsPaneSectionModel,
  t: Translate = translate,
  intlLocale?: string
): React.JSX.Element {
  const {
    accountRuntime,
    accountRuntimeUnavailable,
    accountVisibilityOptions,
    activeCodexAccountId,
    codexAccountPlans,
    codexAccounts,
    codexAction,
    codexRateLimits,
    codexRateLimitTarget,
    isRemoteAccountScope,
    runCodexAccountAction,
    setRemoveCodexTarget,
    setRenameTarget,
    accountOwner
  } = model
  const isActive = providerAccountIsActiveInView(
    account,
    codexAccounts,
    accountRuntime,
    accountVisibilityOptions
  )
  // Desktop rate-limit polls cannot describe remote-owned account auth.
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
  const accountDetail = getCodexAccountDisplayDetail(account, codexAccounts.accounts)
  const plan = getObservedCodexAccountPlan(
    codexAccountPlans,
    account,
    getProviderAccountRuntime(account)
  )
  const isReauthing = codexAction === `reauth:${account.id}`
  const isRemoving = codexAction === `remove:${account.id}`
  const isBusy = codexAction !== 'idle' || accountRuntimeUnavailable

  return (
    <AccountCard
      key={account.id}
      title={getManagedAccountPrimaryLabel(account)}
      tags={
        <AccountCardTag tone="runtime">
          {getCodexAccountRuntimeLabel(account, accountRuntime.label)}
        </AccountCardTag>
      }
      active={isActive}
      attention={
        needsReauthentication &&
        t('auto.components.settings.AccountsPane.589eba1eee', 'Needs re-auth')
      }
      detail={
        <>
          {accountDetail ? (
            <>
              <span className="min-w-0 break-words">{accountDetail}</span>
              <span className="shrink-0 opacity-50">•</span>
            </>
          ) : null}
          {plan ? (
            <>
              <span className="shrink-0">{plan}</span>
              <span className="shrink-0 opacity-50">•</span>
            </>
          ) : null}
          {account.displayName ? (
            <>
              <span className="min-w-0 truncate">{account.email}</span>
              <span className="shrink-0 opacity-50">•</span>
            </>
          ) : null}
          {needsReauthentication ? (
            <>
              <span className="truncate">
                {t(
                  'auto.components.settings.AccountsPane.3d245ef7d9',
                  'Codex reported this sign-in is out of date'
                )}
              </span>
              <span className="shrink-0 opacity-50">•</span>
            </>
          ) : null}
          <span className="shrink-0">
            {formatAccountTimestamp(account.lastAuthenticatedAt, intlLocale)}
          </span>
        </>
      }
      onSelect={() => {
        const accountRuntimeView = getProviderAccountRuntime(account)
        void runCodexAccountAction(
          `select:${account.id}`,
          () =>
            selectCodexProviderAccount(accountOwner, {
              accountId: account.id,
              ...accountRuntimeView
            }),
          accountRuntimeView
        )
      }}
      selectDisabled={isBusy}
      actions={
        <>
          {/* Keep maintenance actions lighter so account selection remains primary in dense lists. */}
          <AccountRenameButton
            t={t}
            disabled={isRemoving}
            pending={model.renamingAccountKeys.has(`codex:${account.id}`)}
            onRename={() =>
              setRenameTarget(renameTargetFor('codex', account, getProviderAccountRuntime(account)))
            }
          />
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={(event) => {
              event.stopPropagation()
              void runCodexAccountAction(
                `reauth:${account.id}`,
                () =>
                  accountOwner.kind === 'environment'
                    ? signInCodexAccountOnHost(accountOwner, account.id)
                    : window.api.codexAccounts.reauthenticate({
                        accountId: account.id
                      }),
                getProviderAccountRuntime(account)
              )
            }}
            disabled={isBusy}
          >
            {isReauthing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {t('auto.components.settings.AccountsPane.8a0f870153', 'Re-authenticate')}
          </Button>
          <Button
            variant="ghost-muted-destructive"
            size="xs"
            onClick={(event) => {
              event.stopPropagation()
              setRemoveCodexTarget({
                id: account.id,
                runtime: getProviderAccountRuntime(account)
              })
            }}
            disabled={isBusy}
          >
            {isRemoving ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3" />
            )}
            {t('auto.components.settings.AccountsPane.db209ee572', 'Remove')}
          </Button>
        </>
      }
    />
  )
}
