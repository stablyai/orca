import { useCallback, useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import type { TailscaleStatus } from '../../../../shared/tailscale-status'

// Why: shown under the "Connect over Tailscale" toggle. It surfaces tailnet
// status and, when the node needs login, a button that opens the control-server
// auth URL in the browser (handled in main via shell.openExternal).
export function TailscaleLoginStatus(): JSX.Element | null {
  const [available, setAvailable] = useState(true)
  const [status, setStatus] = useState<TailscaleStatus | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const res = await window.api.tailscale.status()
    setAvailable(res.available)
    setStatus(res.status)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onLogin = useCallback(async (): Promise<void> => {
    setLoggingIn(true)
    try {
      const res = await window.api.tailscale.login()
      setAvailable(res.available)
      setStatus(res.status)
    } finally {
      setLoggingIn(false)
    }
  }, [])

  if (!available) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'auto.components.settings.TailscaleLoginStatus.unavailable',
          'Tailscale is not available in this build.'
        )}
      </p>
    )
  }

  const connected = status?.state === 'Running'
  const label = connected
    ? translate('auto.components.settings.TailscaleLoginStatus.connected', 'Tailnet connected')
    : translate(
        'auto.components.settings.TailscaleLoginStatus.disconnected',
        'Tailnet not connected'
      )

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={connected ? 'text-foreground' : 'text-muted-foreground'}>
        {label}
        {status?.magicDnsName ? ` · ${status.magicDnsName}` : ''}
      </span>
      {!connected && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loggingIn}
          onClick={() => void onLogin()}
        >
          {loggingIn
            ? translate('auto.components.settings.TailscaleLoginStatus.opening', 'Opening login…')
            : translate(
                'auto.components.settings.TailscaleLoginStatus.login',
                'Log in to Tailscale'
              )}
        </Button>
      )}
    </div>
  )
}
