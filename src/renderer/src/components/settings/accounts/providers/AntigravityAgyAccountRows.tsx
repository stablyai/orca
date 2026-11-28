import { AlertCircle, Eye, RefreshCw, Save, Trash2, UserPlus } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { AntigravityAccountState } from '../../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import { Button } from '../../../ui/button'
import { Label } from '../../../ui/label'
import { AntigravityChatSignInFlowPanel } from '../../../provider-accounts/AntigravityChatSignInFlowPanel'
import type { AntigravityChatSignInControls } from '../../../provider-accounts/use-antigravity-chat-sign-in'
import { AccountCard, AccountCardPlaceholder } from '../account-card'

export type AntigravityAccountAction = 'List' | 'ReadCurrent' | 'AddCurrent' | 'Select' | 'Remove'

/** agy's Google logins, which agy in the terminal and Google-account chats share: the current
 *  login, then saved accounts. With `signIn`, signing in and adding an account run in Orca. */
export function AntigravityAgyAccountRows({
  state,
  error,
  busy,
  windowsHost,
  run,
  signIn
}: {
  state: AntigravityAccountState | null
  error: string | null
  busy: boolean
  windowsHost: boolean
  run: (action: AntigravityAccountAction, accountId?: string) => void
  /** This host's in-app agy sign-in; absent where Orca can't run it (a WSL distro). */
  signIn?: AntigravityChatSignInControls
}): React.JSX.Element {
  const t = useTranslate()
  const signingIn = signIn?.ownFlow === true
  const signInAlert = signIn?.alert ? <ActionError message={signIn.alert} /> : null
  // Until Orca reads agy's login it can't tell which account holds it, so nothing changed yet.
  const unread = state?.currentAccount?.unread === true
  const changed = Boolean(
    !unread && state?.selectedAccountId && state.activeAccountId !== state.selectedAccountId
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
  const changedNote = <span className="text-status-warning-text">{changedText}</span>
  // A running agy on another saved account wrote its login back; the next launch restores the selection.
  const launchesUse =
    state?.restoresSelectionAtLaunch &&
    state.activeAccountId &&
    state.selectedAccountId !== state.activeAccountId &&
    state.accounts.some((account) => account.id === state.selectedAccountId)
      ? state.selectedAccountId
      : null
  // Another account is added from the header once agy holds a login, as Claude and Codex add theirs.
  const addsAccount = Boolean(state?.currentAccount) && !signingIn
  const cards: React.ReactNode[] = []
  if (error && state) {
    cards.push(
      <p key="error" className="text-xs">
        <ActionError message={error} />
      </p>
    )
  } else if (error) {
    cards.push(
      <AccountCard
        key="error"
        title={t('accounts.antigravity.loadFailed', "Couldn't load agy accounts")}
        attention
        detail={<ActionError message={error} />}
        actions={
          <Button size="xs" variant="ghost-muted" disabled={busy} onClick={() => run('List')}>
            <RefreshCw />
            {t('accounts.antigravity.retry', 'Retry')}
          </Button>
        }
      />
    )
  } else if (!state) {
    cards.push(
      <AccountCardPlaceholder key="loading">
        {t('accounts.antigravity.loading', 'Loading accounts…')}
      </AccountCardPlaceholder>
    )
  }
  // A running sign-in takes the current login's place; its panel sits under the header.
  if (!signingIn && state && !state.currentAccount) {
    cards.push(
      <AccountCard
        key="signed-out"
        title={t('accounts.antigravity.notSignedIn', 'Not signed in')}
        detail={
          <DetailLines>
            {signInAlert ??
              (signIn ? null : (
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
              ))}
            {changed ? changedNote : null}
          </DetailLines>
        }
        actions={
          signIn ? (
            <Button size="xs" disabled={signIn.signInDisabled} onClick={signIn.start}>
              {t('accounts.antigravity.signInGoogle', 'Sign in with Google')}
            </Button>
          ) : undefined
        }
      />
    )
  } else if (!signingIn && unread) {
    cards.push(
      <AccountCard
        key="current"
        title={t('accounts.antigravity.signedInUnread', 'agy is signed in')}
        detail={
          <span className="min-w-0">
            {t(
              'accounts.antigravity.unreadDetail',
              'Show the account to see which one. macOS may ask you to allow keychain access.'
            )}
          </span>
        }
        actions={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={busy}
            onClick={() => run('ReadCurrent')}
          >
            <Eye />
            {t('accounts.antigravity.showAccount', 'Show account')}
          </Button>
        }
      />
    )
  } else if (!signingIn && state?.currentAccount && !state.activeAccountId) {
    const { email } = state.currentAccount
    cards.push(
      <AccountCard
        key="current"
        title={email ?? t('accounts.antigravity.currentLogin', 'Current agy login')}
        active
        detail={
          changed ? (
            changedNote
          ) : (
            <span className="truncate">
              {email
                ? t('accounts.antigravity.currentNotSaved', 'Current agy login · not saved')
                : t(
                    'accounts.antigravity.noEmailNotSaved',
                    "agy didn't report an email · not saved"
                  )}
            </span>
          )
        }
        actions={
          <Button size="xs" variant="ghost-muted" disabled={busy} onClick={() => run('AddCurrent')}>
            <Save />
            {t('accounts.antigravity.saveShort', 'Save')}
          </Button>
        }
      />
    )
  }
  for (const account of state?.accounts ?? []) {
    const active = state?.activeAccountId === account.id
    const note =
      account.id === launchesUse
        ? t('accounts.antigravity.launchesUse', 'New agy launches use this account')
        : launchesUse && active
          ? t('accounts.antigravity.loginNow', "agy's login right now")
          : null
    cards.push(
      <AccountCard
        key={account.id}
        title={account.email ?? t('accounts.antigravity.saved', 'Saved Google account')}
        active={active}
        detail={note ? <span className="truncate">{note}</span> : undefined}
        onSelect={() => run('Select', account.id)}
        selectDisabled={busy}
        actions={
          active ? null : (
            <Button
              variant="ghost-muted-destructive"
              size="xs"
              disabled={busy}
              onClick={() => run('Remove', account.id)}
            >
              <Trash2 />
              {t('accounts.antigravity.remove', 'Remove')}
            </Button>
          )
        }
      />
    )
  }
  return (
    <div data-settings-row="" className="space-y-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <Label>{t('auto.components.settings.AccountsPane.94d351af4a', 'Accounts')}</Label>
          {addsAccount ? (
            <p className="text-xs text-muted-foreground">
              {signIn
                ? (signInAlert ??
                  t(
                    'accounts.antigravity.addAccountInApp',
                    'Sign in to another Google account. Both stay saved here to switch between.'
                  ))
                : t(
                    'accounts.antigravity.addAccountHelp',
                    'To add an account, run /logout in agy, sign in again, then Save it here.'
                  )}
            </p>
          ) : null}
        </div>
        {addsAccount && signIn ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy || signIn.signInDisabled}
            onClick={signIn.addAccount}
          >
            <UserPlus />
            {t('accounts.antigravity.addAccount', 'Add account')}
          </Button>
        ) : null}
      </div>
      {signingIn ? (
        <AntigravityChatSignInFlowPanel
          signIn={signIn}
          title={
            <p className="text-sm font-medium">
              {t('accounts.antigravity.signInGoogle', 'Sign in with Google')}
            </p>
          }
        />
      ) : null}
      {cards.length > 0 ? <div className="space-y-2">{cards}</div> : null}
    </div>
  )
}

/** Detail lines that each start on their own line once they don't fit side by side. */
function DetailLines({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">{children}</span>
}

function ActionError({ message }: { message: string }): React.JSX.Element {
  return (
    <span role="alert" className="flex min-w-0 items-center gap-1.5 text-destructive">
      <AlertCircle className="size-3 shrink-0" />
      {message}
    </span>
  )
}
