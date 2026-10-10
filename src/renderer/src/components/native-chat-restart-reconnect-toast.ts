import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import type { RestartMachineKey } from './native-chat-restart-machines'

/**
 * The notice a paired server's restart raises once this desktop reconnects: how many of the user's
 * own chats there were cut off, with a way to resume exactly those or to pick in the dialog.
 *
 * Never shown for this computer, whose own launch opens the dialog instead.
 */
function reconnectToastId(machine: RestartMachineKey): string {
  return `native-chat-restart-reconnect:${machine}`
}

/** An open resume dialog lists these machines' chats and blocks the page under it, so a toast still
 *  on screen above it would only look clickable. */
export function dismissReconnectRestartOffers(machines: readonly RestartMachineKey[]): void {
  for (const machine of machines) {
    toast.dismiss(reconnectToastId(machine))
  }
}

export function announceReconnectRestartOffer(args: {
  machine: RestartMachineKey
  machineName: string
  own: readonly ResumeCandidate[]
  resume: (sessionIds: readonly string[]) => void
  show: () => void
}): void {
  const { machineName, own } = args
  if (own.length === 0) {
    return
  }
  const title = own.some((candidate) => candidate.trigger === 'update')
    ? translate(
        'auto.components.NativeChatResumeOnRestartModal.reconnectUpdateTitle',
        '{{value0}} restarted for an update',
        { value0: machineName }
      )
    : translate(
        'auto.components.NativeChatResumeOnRestartModal.reconnectQuitTitle',
        'Orca on {{value0}} was restarted',
        { value0: machineName }
      )
  const description =
    own.length === 1
      ? translate(
          'auto.components.NativeChatResumeOnRestartModal.reconnectBodyOne',
          '1 of your chats there was stopped mid-reply. It shows where it stopped, and nothing was lost.'
        )
      : translate(
          'auto.components.NativeChatResumeOnRestartModal.reconnectBodyMany',
          '{{value0}} of your chats there were stopped mid-reply. Each one shows where it stopped, and nothing was lost.',
          { value0: own.length }
        )
  const sessionIds = own.map((candidate) => candidate.sessionId)
  toast(title, {
    // One per machine: a newer restart of the same server replaces the older notice.
    id: reconnectToastId(args.machine),
    description,
    action: {
      label:
        own.length === 1
          ? translate(
              'auto.components.NativeChatResumeOnRestartModal.resumeSelectedOne',
              'Resume 1 chat'
            )
          : translate(
              'auto.components.NativeChatResumeOnRestartModal.resumeSelected',
              'Resume {{value0}} chats',
              { value0: own.length }
            ),
      onClick: () => args.resume(sessionIds)
    },
    cancel: {
      label: translate(
        'auto.components.NativeChatResumeOnRestartModal.reconnectShow',
        'Show chats'
      ),
      onClick: args.show
    }
  })
}
