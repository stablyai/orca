import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/**
 * The user asked for a terminal and the host never mirrored one, so no pane exists to show why.
 * "Couldn't confirm" stays true when the reply was lost and the terminal appears later; the reason
 * carries the host's refusal or the transport failure as reported. No retry: it could duplicate.
 */
export function notifyWebRuntimeTerminalCreateFailure(
  reason: string,
  scope: { environmentId: string | null; worktreeId: string }
): void {
  toast.error(
    translate(
      'auto.runtime.webRuntimeSession.terminalCreateUnconfirmed',
      'Orca couldn’t confirm that the new terminal opened on the host.'
    ),
    {
      // Why an id: automatic seeding retries on every reconnect and must not stack toasts.
      id: `web-runtime-terminal-create:${scope.environmentId ?? 'active'}:${scope.worktreeId}`,
      ...(reason ? { description: reason } : {})
    }
  )
}
