import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { INLINE_ACTION_CLASS_NAMES } from '@/components/ui/sonner'

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
  const description = notMovedDescription(others)
  if (!review) {
    toast.success(title, { description })
    return
  }
  toast.success(title, {
    description,
    classNames: INLINE_ACTION_CLASS_NAMES,
    action: {
      label: translate('accounts.claude.switchSessions.review', 'Review'),
      onClick: review
    }
  })
}

function notMovedDescription(others: number): string {
  return others === 1
    ? translate('accounts.claude.switchSessions.notMovedOne', "1 other session wasn't moved.")
    : translate(
        'accounts.claude.switchSessions.notMovedOther',
        "{{count}} other sessions weren't moved.",
        { count: others }
      )
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
export function warnStrandedSessions(count: number, previous: string, review: () => void): void {
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
    {
      classNames: INLINE_ACTION_CLASS_NAMES,
      action: {
        label: translate('accounts.claude.switchSessions.review', 'Review'),
        onClick: review
      }
    }
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

export function warnSessionsLeftBehind(count: number, account: string): void {
  toast.warning(
    count === 1
      ? translate(
          'accounts.claude.switchSessions.notMovedToOne',
          "1 session wasn't moved to {{account}}.",
          { account }
        )
      : translate(
          'accounts.claude.switchSessions.notMovedToOther',
          "{{count}} sessions weren't moved to {{account}}.",
          { count, account }
        )
  )
}
