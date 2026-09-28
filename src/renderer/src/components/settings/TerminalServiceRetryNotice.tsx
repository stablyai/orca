import { useState } from 'react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

export function TerminalServiceRetryNotice({
  onRecovered
}: {
  onRecovered: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const retry = async (): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    setFailed(false)
    try {
      const result = await window.api.pty.management.retry()
      if (result.success) {
        onRecovered()
      } else {
        setFailed(true)
      }
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground" role="status">
        {failed
          ? translate(
              'terminal.service.retryFailed',
              'The terminal service is still unavailable. Retry preserves existing sessions. You can also use Restart daemon below; restarting closes its running sessions.'
            )
          : translate(
              'terminal.service.unavailable',
              'New terminals are unavailable. Retry the terminal service without stopping existing sessions.'
            )}
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void retry()}
      >
        {translate('terminal.service.retry', 'Retry terminal service')}
      </Button>
    </div>
  )
}
