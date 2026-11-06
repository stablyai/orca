import { useState } from 'react'
import { connectRuntimeHostAndReloadProjects } from '@/components/status-bar/runtime-environment-explicit-connect'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { startWslHostAndReloadProjects } from '@/lib/wsl-host-user-start'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import type { NativeChatHostOutage } from './use-native-chat-host-outage'

export function useNativeChatHostOutageNotice(
  outage: NativeChatHostOutage | null
): NativeChatComposerNotice | null {
  const [connecting, setConnecting] = useState(false)
  const mountedRef = useMountedRef()
  const reconnect = (environmentId: string, start: boolean): void => {
    setConnecting(true)
    void (
      start
        ? startWslHostAndReloadProjects(environmentId)
        : connectRuntimeHostAndReloadProjects(environmentId)
    ).finally(() => {
      if (mountedRef.current) {
        setConnecting(false)
      }
    })
  }
  if (!outage) {
    return null
  }
  if (outage.kind === 'stopped') {
    return {
      key: 'host-outage',
      kind: 'host',
      tone: 'warning',
      text: translate('components.native-chat.hostOutage.stopped', '{{distro}} is stopped', {
        distro: outage.hostLabel
      }),
      action: {
        label: translate('components.native-chat.hostOutage.start', 'Start'),
        onClick: () => reconnect(outage.environmentId, true),
        disabled: connecting
      }
    }
  }
  const offline = outage.kind === 'offline'
  return {
    key: 'host-outage',
    kind: 'host',
    tone: offline ? 'warning' : 'muted',
    text: offline
      ? translate('components.native-chat.hostOutage.offline', '{{hostName}} is offline', {
          hostName: outage.hostLabel
        })
      : translate(
          'components.native-chat.hostOutage.reconnecting',
          '{{hostName}} is reconnecting…',
          {
            hostName: outage.hostLabel
          }
        ),
    ...(outage.canReconnect
      ? {
          action: {
            label: translate('components.native-chat.hostOutage.reconnect', 'Reconnect'),
            onClick: () => reconnect(outage.environmentId, false),
            disabled: connecting
          }
        }
      : {})
  }
}
