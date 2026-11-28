import { AlertCircle, Trash2, UserPlus } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { AntigravityAccountState } from '../../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'
import { AntigravityChatSignInFlowPanel } from '../../../provider-accounts/AntigravityChatSignInFlowPanel'
import type { AntigravityChatSignInControls } from '../../../provider-accounts/use-antigravity-chat-sign-in'

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
  // A running agy on another saved account wrote its login back; the next launch restores the selection.
  const launchesUse =
    state?.restoresSelectionAtLaunch &&
    state.activeAccountId &&
    state.selectedAccountId !== state.activeAccountId &&
    state.accounts.some((account) => account.id === state.selectedAccountId)
      ? state.selectedAccountId
      : null
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
  if (signingIn) {
    terminalRows.push(
      <div key="signing-in" data-settings-row="" className="py-3">
        <AntigravityChatSignInFlowPanel
          signIn={signIn}
          title={
            <p className="text-sm font-medium">
              {t('accounts.antigravity.signInGoogle', 'Sign in with Google')}
            </p>
          }
        />
      </div>
    )
  } else if (state && !state.currentAccount) {
    terminalRows.push(
      <AntigravityAccountRow
        key="signed-out"
        title={t('accounts.antigravity.notSignedIn', 'Not signed in')}
        detail={
          <>
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
            {changed ? <span className="text-status-warning-text">{changedText}</span> : null}
          </>
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
  } else if (unread) {
    terminalRows.push(
      <AntigravityAccountRow
        key="current"
        title={t('accounts.antigravity.signedInUnread', 'agy is signed in')}
        detail={t(
          'accounts.antigravity.unreadDetail',
          'Show the account to see which one. macOS may ask you to allow keychain access.'
        )}
        actions={
          <Button size="xs" variant="outline" disabled={busy} onClick={() => run('ReadCurrent')}>
            {t('accounts.antigravity.showAccount', 'Show account')}
          </Button>
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
          changed ? (
            <span className="text-status-warning-text">{changedText}</span>
          ) : email ? (
            t('accounts.antigravity.currentNotSaved', 'Current agy login · not saved')
          ) : (
            t('accounts.antigravity.noEmailNotSaved', "agy didn't report an email · not saved")
          )
        }
        actions={
          <Button size="xs" variant="outline" disabled={busy} onClick={() => run('AddCurrent')}>
            {t('accounts.antigravity.saveShort', 'Save')}
          </Button>
        }
      />
    )
  }
  for (const account of state?.accounts ?? []) {
    const active = state?.activeAccountId === account.id
    terminalRows.push(
      <AntigravityAccountRow
        key={account.id}
        title={account.email ?? t('accounts.antigravity.saved', 'Saved Google account')}
        active={active}
        detail={
          account.id === launchesUse
            ? t('accounts.antigravity.launchesUse', 'New agy launches use this account')
            : launchesUse && active
              ? t('accounts.antigravity.loginNow', "agy's login right now")
              : undefined
        }
        selectDisabled={busy}
        onSelect={() => run('Select', account.id)}
        actions={
          active ? null : (
            <Button
              variant="ghost"
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
  if (state?.currentAccount && !signingIn) {
    terminalRows.push(
      signIn ? (
        <AntigravityAccountRow
          key="add-account"
          title={null}
          detail={
            signInAlert ??
            t(
              'accounts.antigravity.addAccountInApp',
              'Sign in to another Google account. Both stay saved here to switch between.'
            )
          }
          actions={
            <Button
              size="xs"
              variant="outline"
              disabled={busy || signIn.signInDisabled}
              onClick={signIn.addAccount}
            >
              <UserPlus />
              {t('accounts.antigravity.addAccount', 'Add account')}
            </Button>
          }
        />
      ) : (
        <div
          key="add-account"
          data-settings-row=""
          className="flex items-center gap-2 py-3 text-xs text-muted-foreground"
        >
          <UserPlus className="size-3.5 shrink-0" />
          <span>
            {t(
              'accounts.antigravity.addAccountHelp',
              'To add an account, run /logout in agy, sign in again, then Save it here.'
            )}
          </span>
        </div>
      )
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
