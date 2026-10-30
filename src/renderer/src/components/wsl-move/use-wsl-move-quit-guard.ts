import { useEffect } from 'react'
import { translate } from '@/i18n/i18n'
import { isIntentionalAppRestartInProgress } from '@/lib/updater-beforeunload'
import type { ConfirmationDialogOptions } from '../confirmation-dialog-context'
import { registerWindowCloseGuard } from '../window-close-request-coordinator'

// The close request is already acknowledged when guards run; a hung ask would block quitting.
const IS_RUNNING_TIMEOUT_MS = 2_000

function answeredWithin(answer: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  return Promise.race([answer.catch(() => false), timeout]).finally(() => clearTimeout(timer))
}

/**
 * Quitting (or closing the window) mid-move loses the run; the next launch undoes it safely, but
 * the user should choose that. Asks only while main reports a move running.
 */
export async function confirmQuitDuringWslMove(
  isRunning: () => Promise<boolean>,
  confirm: (options: ConfirmationDialogOptions) => Promise<boolean>
): Promise<boolean> {
  if (isIntentionalAppRestartInProgress()) {
    return true
  }
  // Unknown is not running: a failed or hung ask must never trap the user in the app.
  if (!(await answeredWithin(isRunning(), IS_RUNNING_TIMEOUT_MS))) {
    return true
  }
  return confirm({
    title: translate('sidebar.wslMoved.quitDuringMoveTitle', 'Quit while a project is moving?'),
    description: translate(
      'sidebar.wslMoved.quitDuringMoveDescription',
      'A project is moving to its WSL host. Quit anyway? The move will be undone at next launch.'
    ),
    confirmLabel: translate('sidebar.wslMoved.quitDuringMoveConfirm', 'Quit anyway'),
    confirmVariant: 'destructive'
  })
}

export function useWslMoveQuitGuard(
  enabled: boolean,
  confirm: (options: ConfirmationDialogOptions) => Promise<boolean>
): void {
  useEffect(
    () =>
      enabled
        ? registerWindowCloseGuard(() =>
            confirmQuitDuringWslMove(() => window.api.wslMove.isRunning(), confirm)
          )
        : undefined,
    [enabled, confirm]
  )
}
