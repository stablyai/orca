import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { describeClaudePinnedLaunchError } from './claude-pinned-launch-error-copy'

/** Offered only for a refused pinned Claude launch whose account the active one can stand in for. */
export function StartOnActiveAccountButton({
  error,
  onClick
}: {
  error: string
  onClick?: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!onClick || !describeClaudePinnedLaunchError(error)?.offerActiveAccount) {
    return null
  }
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      {t(
        'auto.components.terminal.pane.TerminalErrorToast.startOnActiveAccount',
        'Start on active account'
      )}
    </Button>
  )
}
