import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { describeClaudePinnedLaunchError } from '@/components/terminal-pane/claude-pinned-launch-error-copy'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../shared/claude/project-claude-account-preference'

export function toastWebHostLaunchFailure(
  message: string | undefined,
  fallbackMessage: string,
  relaunch: ((claudeAccountId?: string) => void) | undefined
): void {
  const pinned = message ? describeClaudePinnedLaunchError(message) : null
  if (!pinned) {
    toast.error(fallbackMessage)
    return
  }
  const action = !relaunch
    ? undefined
    : pinned.offerActiveAccount
      ? {
          label: translate(
            'auto.components.terminal.pane.TerminalErrorToast.startOnActiveAccount',
            'Start on active account'
          ),
          onClick: () => relaunch(ACTIVE_CLAUDE_ACCOUNT)
        }
      : undefined
  toast.error(pinned.message, action ? { action } : undefined)
}
