import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { INLINE_ACTION_CLASS_NAMES } from '@/components/ui/sonner'
import type { ClaudeHostRunningSessionsMove } from '../../../../shared/agent-accounts/managed-account-types'
import type { AccountSwitchCopy } from './account-switch-copy'

/** Asks the server to restart the sessions it left running under Ask; resolves with what it did. */
export type RestartHostSessions = () => Promise<ClaudeHostRunningSessionsMove | undefined>

export function dismissHostAskToast(toastId: string): void {
  toast.dismiss(toastId)
}

/** Says what a server did with its own running terminals after a switch. `toastId` lets a later
 *  switch replace this one's Ask. */
export function announceHostAccountMove(
  copy: AccountSwitchCopy,
  move: ClaudeHostRunningSessionsMove | undefined,
  labels: { previous: string; next: string },
  restart?: RestartHostSessions,
  toastId?: string
): 'show-confirmation' | 'handled' {
  if (move && move.restarting > 0) {
    announceAccountRestart(copy, move.restarting, labels.next, move.notMoved, undefined, move.fresh)
    return 'handled'
  }
  if (move?.canRestart && restart) {
    askHostRestart(
      copy,
      move.canRestart,
      labels.previous,
      () => {
        void restart().then(
          (moved) => announceHostAccountMove(copy, moved, labels),
          (error: unknown) => {
            console.error(`[${copy.agent}-account-switch] server restart failed:`, error)
            toast.error(copy.updateFailed)
          }
        )
      },
      toastId
    )
    return 'handled'
  }
  if (move && move.notMoved > 0) {
    warnStrandedAccountSessions(copy, move.notMoved, labels.previous)
  }
  return 'show-confirmation'
}

/** Why a toast: the server left these running because the setting is Ask, and only here can it be answered. */
function askHostRestart(
  copy: AccountSwitchCopy,
  count: number,
  previous: string,
  restart: () => void,
  toastId?: string
): void {
  toast.warning(copy.hostAsk(count, previous), {
    ...(toastId ? { id: toastId } : {}),
    description: translate(
      'accounts.claude.switchSessions.hostAskDescription',
      'Restarting stops any work in progress.'
    ),
    classNames: INLINE_ACTION_CLASS_NAMES,
    action: {
      label: translate('accounts.claude.switchSessions.hostAskRestart', 'Restart'),
      onClick: restart
    }
  })
}

/** Name the sessions left behind and offer the same list, without the ones already restarting. */
export function announceAccountRestart(
  copy: AccountSwitchCopy,
  count: number,
  account: string,
  others: number,
  review?: () => void,
  /** Of `count`, those starting a new conversation because Orca doesn't know theirs. */
  fresh = 0
): void {
  const title = copy.restarting(count, account)
  const notes = [
    fresh > 0 ? copy.freshRestarts?.(fresh) : undefined,
    others === 0
      ? undefined
      : others === 1
        ? translate('accounts.claude.switchSessions.notMovedOne', "1 other session wasn't moved.")
        : translate(
            'accounts.claude.switchSessions.notMovedOther',
            "{{count}} other sessions weren't moved.",
            { count: others }
          )
  ].filter((note): note is string => Boolean(note))
  if (notes.length === 0) {
    toast.success(title)
    return
  }
  toast.success(title, {
    description: notes.join(' '),
    // A server's sessions have no rows here to review.
    ...(review && others > 0 ? reviewAction(review) : {})
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

/** Why a toast: nothing else moved, so no dialog lists the sessions Orca couldn't restart. */
export function warnStrandedAccountSessions(
  copy: AccountSwitchCopy,
  count: number,
  previous: string,
  review?: () => void
): void {
  toast.warning(copy.stranded(count, previous), review ? reviewAction(review) : undefined)
}
