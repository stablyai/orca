import { FolderLock, FolderSync, Loader2 } from 'lucide-react'
import type { ClaudeRateLimitAccountsState } from '../../../../../../shared/agent-accounts/managed-account-types'
import type { Translate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import type { AccountsPaneSectionModel } from '../accounts-pane-types'

/** Toggles whether a host account keeps its conversations apart from System default's history.
 *  Desktop only: a paired server's accounts and WSL lanes keep the shared history. */
export function ClaudeHistoryIsolationButton({
  account,
  model,
  t
}: {
  account: ClaudeRateLimitAccountsState['accounts'][number]
  model: AccountsPaneSectionModel
  t: Translate
}): React.JSX.Element | null {
  const setHistoryIsolated = window.api.claudeAccounts.setHistoryIsolated
  if (
    !setHistoryIsolated ||
    model.accountOwner.kind !== 'local' ||
    account.managedAuthRuntime === 'wsl'
  ) {
    return null
  }
  const isolated =
    model.settings.claudeManagedAccounts.find((saved) => saved.id === account.id)
      ?.historyIsolated === true
  const action = `history:${account.id}` as const
  const pending = model.claudeAction === action
  const label = isolated
    ? t('accounts.claude.historySeparate', 'Separate history')
    : t('accounts.claude.historyShared', 'Shared history')
  const hint = isolated
    ? t(
        'accounts.claude.historySeparateHint',
        'This account keeps its conversations in its own folder. Click to share them with your other accounts again.'
      )
    : t(
        'accounts.claude.historySharedHint',
        'This account’s conversations join your other accounts’ history. Click to keep new ones apart; earlier ones stay shared, and Orca chats created on it move over when resumed.'
      )
  return (
    <Button
      variant={isolated ? 'secondary' : 'ghost'}
      size="xs"
      aria-pressed={isolated}
      title={hint}
      disabled={model.claudeAction !== 'idle' || model.accountRuntimeUnavailable}
      onClick={(event) => {
        event.stopPropagation()
        void model.runClaudeAccountAction(action, () =>
          setHistoryIsolated({ accountId: account.id, isolated: !isolated })
        )
      }}
    >
      {pending ? (
        <Loader2 className="size-3 animate-spin" />
      ) : isolated ? (
        <FolderLock className="size-3" />
      ) : (
        <FolderSync className="size-3" />
      )}
      {label}
    </Button>
  )
}
