import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { WebRuntimeTerminalCreateOutcome } from '@/runtime/web-runtime-session-types'

/**
 * Tells the user a paired-host create got no answer. Deliberately not an error with a retry: the
 * host may have created it, and a second click would create another.
 */
export function notifyUnconfirmedWebRuntimeTerminalCreate(subject: string | null): void {
  toast.warning(
    subject
      ? translate(
          'runtime.webRuntimeSession.createUnconfirmedNamed',
          "Couldn't confirm {{value0}} started on the remote host",
          { value0: subject }
        )
      : translate(
          'runtime.webRuntimeSession.createUnconfirmed',
          "Couldn't confirm the terminal started on the remote host"
        ),
    {
      description: translate(
        'runtime.webRuntimeSession.createUnconfirmedDetail',
        'The connection dropped before the host answered. If it started, its tab appears when the connection recovers.'
      )
    }
  )
}

/** Surfaces a plain paired-host terminal create's outcome; success needs no message. */
export function notifyWebRuntimeTerminalCreateOutcome(
  outcome: WebRuntimeTerminalCreateOutcome
): void {
  if (outcome.status === 'unconfirmed') {
    notifyUnconfirmedWebRuntimeTerminalCreate(null)
  } else if (outcome.status === 'failed') {
    toast.error(
      outcome.message ||
        translate(
          'runtime.webRuntimeSession.createFailed',
          "Couldn't open a terminal on the remote host."
        )
    )
  }
}
