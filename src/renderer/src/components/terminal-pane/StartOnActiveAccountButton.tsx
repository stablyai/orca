import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { describeClaudePinnedLaunchError } from './claude-pinned-launch-error-copy'

/** Offered only for a refused pinned Claude launch whose account the active one can stand in for. */
export function StartOnActiveAccountButton({
  error,
  onClick
}: {
  error: string
  onClick?: () => void
}): React.JSX.Element | null {
  if (!onClick || !describeClaudePinnedLaunchError(error)?.offerActiveAccount) {
    return null
  }
  return (
    <Button variant="outline" size="xs" onClick={onClick} className="ml-3">
      {translate(
        'auto.components.terminal.pane.TerminalErrorToast.startOnActiveAccount',
        'Start on active account'
      )}
    </Button>
  )
}
