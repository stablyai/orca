import { useState } from 'react'
import { toast } from 'sonner'
import { connectRuntimeHostAndReloadProjects } from '@/components/status-bar/runtime-environment-explicit-connect'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
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

/** Start is the user acting on the host, so it may boot the distro; then the chat reconnects. */
async function startWslHostAndReloadProjects(environmentId: string): Promise<boolean> {
  try {
    // A chat's Start must not quietly cancel a Remove the user started; that refusal says so.
    await window.api.runtimeEnvironments.wslHosts?.connect({
      environmentId,
      withdrawPendingRemoval: false
    })
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
  return connectRuntimeHostAndReloadProjects(environmentId)
}
