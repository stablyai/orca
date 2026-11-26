import { useState } from 'react'
import { RemoteRuntimeRecoveryCard } from '@/components/terminal-pane/pty-transport/remote-runtime/recovery/RemoteRuntimeRecoveryCard'
import { connectRuntimeHostAndReloadProjects } from '@/components/status-bar/host-connections/runtime-environment-explicit-connect'
import type { NativeChatHostOutage } from '@/components/native-chat/host-access/use-native-chat-host-outage'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'

/**
 * In place of the composer on a bot's page while its server is down: the remote terminal's own
 * recovery card, retrying first, then Reconnect once retries stop. The chat stays as last read.
 */
export function BotServerOutageCard({
  outage
}: {
  outage: NativeChatHostOutage
}): React.JSX.Element {
  const t = useTranslate()
  // The card mounts with the outage, so its timer counts from when the page saw it go.
  const [downSince] = useState(() => Date.now())
  const [connecting, setConnecting] = useState(false)
  const mountedRef = useMountedRef()
  const host = outage.hostLabel
  const stopped = outage.kind === 'offline'
  return (
    // The card floats at the bottom of this slot, where the composer was.
    <div className="relative min-h-20 shrink-0">
      <RemoteRuntimeRecoveryCard
        icon={stopped ? 'stopped' : 'retrying'}
        data={{ 'data-bot-server-outage': outage.kind }}
        title={
          stopped
            ? t('bots.page.serverDownTitle', 'Can’t reach {{host}}', { host })
            : t('bots.page.serverReconnectingTitle', 'Reconnecting to {{host}}', { host })
        }
        body={
          stopped
            ? t(
                'bots.page.serverDownBody',
                'Check that Orca is running on {{host}}, then reconnect.',
                {
                  host
                }
              )
            : t(
                'bots.page.serverReconnectingBody',
                'The connection to the server dropped. Orca is retrying automatically.'
              )
        }
        downSince={downSince}
        action={
          stopped && outage.canReconnect && !connecting
            ? {
                label: t('bots.page.serverReconnect', 'Reconnect'),
                onClick: () => {
                  setConnecting(true)
                  void connectRuntimeHostAndReloadProjects(outage.environmentId).finally(() => {
                    if (mountedRef.current) {
                      setConnecting(false)
                    }
                  })
                }
              }
            : null
        }
      />
    </div>
  )
}
