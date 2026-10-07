import { useState } from 'react'
import { WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { connectRuntimeHostAndReloadProjects } from '@/components/status-bar/runtime-environment-explicit-connect'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { NativeChatHostOutage } from './use-native-chat-host-outage'

/** One line naming the chat's host while Orca can't reach it; offline offers the status bar's
 *  Connect unless the host refused us. The live region stays mounted while empty, so it is announced. */
export function NativeChatHostOutageNotice({
  outage
}: {
  outage: NativeChatHostOutage | null
}): React.JSX.Element {
  const [connecting, setConnecting] = useState(false)
  const mountedRef = useMountedRef()
  const reconnect = (environmentId: string): void => {
    setConnecting(true)
    void connectRuntimeHostAndReloadProjects(environmentId).finally(() => {
      if (mountedRef.current) {
        setConnecting(false)
      }
    })
  }
  const offline = outage?.kind === 'offline'
  return (
    <div role="status">
      {outage ? (
        <div
          className={cn(
            'mx-auto flex w-full max-w-(--chat-content-max-width) items-center gap-2 px-4 py-1 text-xs',
            offline ? 'text-status-warning' : 'text-muted-foreground'
          )}
        >
          <WifiOff className="size-3.5 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1 truncate">
            {offline
              ? translate('components.native-chat.hostOutage.offline', '{{hostName}} is offline', {
                  hostName: outage.hostLabel
                })
              : translate(
                  'components.native-chat.hostOutage.reconnecting',
                  '{{hostName}} is reconnecting…',
                  { hostName: outage.hostLabel }
                )}
          </p>
          {outage.canReconnect ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={connecting}
              onClick={() => reconnect(outage.environmentId)}
            >
              {translate('components.native-chat.hostOutage.reconnect', 'Reconnect')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
