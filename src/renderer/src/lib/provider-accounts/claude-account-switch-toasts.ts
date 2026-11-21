import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { INLINE_ACTION_CLASS_NAMES } from '@/components/ui/sonner'
import type { ClaudeHostRunningSessionsMove } from '../../../../shared/agent-accounts/managed-account-types'
import { getClaudeAccountLabel } from './claude-account-label'
import type { ClaudeAccountSnapshot } from './claude-account-switch-sessions'

export function announceHostMove(
  move: ClaudeHostRunningSessionsMove | undefined,
  before: ClaudeAccountSnapshot,
  after: ClaudeAccountSnapshot
): 'show-confirmation' | 'handled' {
  if (move && move.restarting > 0) {
    announceRestart(
      move.restarting,
      getClaudeAccountLabel(after.state, after.accountId),
      move.notMoved
    )
    return 'handled'
  }
  if (move && move.notMoved > 0) {
    warnStrandedSessions(move.notMoved, getClaudeAccountLabel(before.state, before.accountId))
  }
  return 'show-confirmation'
}

/** Name the sessions left behind and offer the same list, without the ones already restarting. */
export function announceRestart(
  count: number,
  account: string,
  others: number,
  review?: () => void
): void {
  const title =
    count === 1
      ? translate(
          'accounts.claude.switchSessions.restartingOne',
          'Restarting 1 Claude session on {{account}}',
          { account }
        )
      : translate(
          'accounts.claude.switchSessions.restartingOther',
          'Restarting {{count}} Claude sessions on {{account}}',
          { count, account }
        )
  if (others === 0) {
    toast.success(title)
    return
  }
  toast.success(title, {
    description:
      others === 1
        ? translate('accounts.claude.switchSessions.notMovedOne', "1 other session wasn't moved.")
        : translate(
            'accounts.claude.switchSessions.notMovedOther',
            "{{count}} other sessions weren't moved.",
            { count: others }
          ),
    // A server's sessions have no rows here to review.
    ...(review ? reviewAction(review) : {})
  })
}

function reviewAction(review: () => void) {
  return {
    classNames: INLINE_ACTION_CLASS_NAMES,
    action: {
      label: translate('accounts.claude.switchSessions.review', 'Review'),
      onClick: review
    }
  }
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

/** Why a toast: nothing else moved, so no dialog lists the Claude sessions Orca couldn't restart. */
export function warnStrandedSessions(count: number, previous: string, review?: () => void): void {
  toast.warning(
    count === 1
      ? translate(
          'accounts.claude.switchSessions.strandedOne',
          '1 Claude session may still be on {{previous}}. Restart it manually to switch.',
          { previous }
        )
      : translate(
          'accounts.claude.switchSessions.strandedOther',
          '{{count}} Claude sessions may still be on {{previous}}. Restart them manually to switch.',
          { count, previous }
        ),
    review ? reviewAction(review) : undefined
  )
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
