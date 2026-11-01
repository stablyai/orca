import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

// No mirrored pane can show create errors. “Couldn’t confirm” remains accurate if a lost reply’s terminal later appears; report host/transport reason without retrying and risking duplicates.
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
