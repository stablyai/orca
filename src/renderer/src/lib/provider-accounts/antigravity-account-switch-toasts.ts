// Selecting a saved Antigravity account takes effect at once: new chats use it, and running ones
// move at their next message. The toast says which account that is, wherever Settings is shown.

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AntigravityAccountState } from '../../../../shared/agent-accounts/antigravity/antigravity-account-types'

export function announceAntigravityAccountSwitch(
  state: AntigravityAccountState,
  accountId: string
): void {
  const account = state.accounts.find((entry) => entry.id === accountId)
  toast.success(
    translate('accounts.antigravity.switched', 'Switched to {{account}}', {
      account:
        account?.email ??
        account?.subject ??
        translate('accounts.antigravity.saved', 'Saved Google account')
    }),
    {
      description: translate(
        'accounts.antigravity.switchedDescription',
        'New chats use it now. Chats running a turn switch at their next message.'
      )
    }
  )
}

export function announceAntigravityAccountSwitchFailure(cause: unknown): void {
  const reason = cause instanceof Error && cause.message ? cause.message : undefined
  toast.error(
    translate('accounts.antigravity.switchFailedToast', 'Antigravity account update failed.'),
    reason ? { description: reason } : undefined
  )
}
