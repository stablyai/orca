import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { ClaudeManagedAccountSummary } from '../../../shared/managed-account-types'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { claudeAccountToSignIn, signInToClaudeAccount } from './claude-account-sign-in'

const NOTICE_TOAST_ID = 'claude-account-sign-in-notice'

function showClaudeAccountSignInNotice(account: ClaudeManagedAccountSummary): void {
  toast.info(
    translate('accounts.claude.signInNotice.title', 'Finish setting up your Claude accounts'),
    {
      // Why a stable id: a late sync that resets the flag can't stack a second toast.
      id: NOTICE_TOAST_ID,
      description: translate(
        'accounts.claude.signInNotice.description',
        "Sign in to each saved account once and you're ready to switch anytime."
      ),
      // Why no timeout: it is marked seen before showing, so an auto-close would lose it for good.
      duration: Infinity,
      action: {
        label: translate('accounts.claude.signInNotice.action', 'Sign in to {{value0}}', {
          value0: account.email
        }),
        onClick: () => void signInToClaudeAccount(account.id)
      }
    }
  )
}

/** Once, on the first launch after the update: only when a saved account still needs a sign-in. */
export function useClaudeAccountSignInNotice(): void {
  // Why no hydration check: the flag defaults to true until the persisted value arrives.
  const seen = useAppStore((s) => s.claudeAccountSignInNoticeSeen)

  useEffect(() => {
    // Why skip paired web clients: the accounts are the host's, whose own window shows this.
    if (seen || isPairedWebClientWindow()) {
      return
    }
    let cancelled = false
    void window.api.claudeAccounts
      .list()
      .then((state) => {
        if (cancelled) {
          return
        }
        // Why mark either way: the update happened once; a later sign-out is not this news.
        useAppStore.getState().markClaudeAccountSignInNoticeSeen()
        const accountId = claudeAccountToSignIn(state)
        const account = state.accounts.find((candidate) => candidate.id === accountId)
        if (account) {
          showClaudeAccountSignInNotice(account)
        }
      })
      .catch((error: unknown) => console.warn('[claude-accounts] Sign-in notice skipped:', error))
    return () => {
      cancelled = true
    }
  }, [seen])
}
