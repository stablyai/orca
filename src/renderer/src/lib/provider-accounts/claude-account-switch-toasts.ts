import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ClaudeHostRunningSessionsMove } from '../../../../shared/agent-accounts/managed-account-types'
import { getClaudeAccountLabel } from './claude-account-label'
import type { ClaudeAccountSnapshot } from './claude-account-switch-sessions'
import { claudeAccountSwitchCopy } from './account-switch-copy'
import {
  announceAccountRestart,
  announceHostAccountMove,
  warnStrandedAccountSessions,
  type RestartHostSessions
} from './account-switch-toasts'

export { dismissHostAskToast } from './account-switch-toasts'

export function announceHostMove(
  move: ClaudeHostRunningSessionsMove | undefined,
  before: ClaudeAccountSnapshot,
  after: ClaudeAccountSnapshot,
  restart?: RestartHostSessions,
  toastId?: string
): 'show-confirmation' | 'handled' {
  return announceHostAccountMove(
    claudeAccountSwitchCopy(),
    move,
    {
      previous: getClaudeAccountLabel(before.state, before.accountId),
      next: getClaudeAccountLabel(after.state, after.accountId)
    },
    restart,
    toastId
  )
}

export function announceRestart(
  count: number,
  account: string,
  others: number,
  review?: () => void
): void {
  announceAccountRestart(claudeAccountSwitchCopy(), count, account, others, review)
}

/** Why a toast: these sessions keep the previous account, and only a manual restart moves them. */
export function warnUncheckedSessions(count: number, previous: string): void {
  toast.warning(
    count === 1
      ? translate(
          'accounts.claude.switchSessions.uncheckedOne',
          "Couldn't check 1 terminal for Claude. If Claude is running there, it stays on {{previous}} until restarted.",
          { previous }
        )
      : translate(
          'accounts.claude.switchSessions.uncheckedOther',
          "Couldn't check {{count}} terminals for Claude. Any Claude running there stays on {{previous}} until restarted.",
          { count, previous }
        )
  )
}

export function warnStrandedSessions(count: number, previous: string, review?: () => void): void {
  warnStrandedAccountSessions(claudeAccountSwitchCopy(), count, previous, review)
}

/** Why a toast: with nothing else to move, no dialog says why these sessions stayed. */
export function warnSharedSessions(count: number, previous: string): void {
  toast.warning(
    count === 1
      ? translate(
          'accounts.claude.switchSessions.sharedOne',
          "1 Claude session stays on {{previous}} because another pane has the same conversation open. Restarting could reopen the other pane's conversation.",
          { previous }
        )
      : translate(
          'accounts.claude.switchSessions.sharedOther',
          "{{count}} Claude sessions stay on {{previous}} because another pane has the same conversation open. Restarting could reopen the other pane's conversation.",
          { count, previous }
        )
  )
}
