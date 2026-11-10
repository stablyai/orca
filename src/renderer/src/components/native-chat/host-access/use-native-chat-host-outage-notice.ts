import { useState } from 'react'
import { connectRuntimeHostAndReloadProjects } from '@/components/status-bar/runtime-environment-explicit-connect'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { startWslHostAndReloadProjects } from '@/runtime/hosts/wsl/wsl-host-user-start'
import type { NativeChatComposerNotice } from '../composer/controls/native-chat-composer-notice'
import type { NativeChatHostOutage } from './use-native-chat-host-outage'

export function useNativeChatHostOutageNotice(
  outage: NativeChatHostOutage | null
): NativeChatComposerNotice | null {
  const t = useTranslate()
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
      text: t('components.native-chat.hostOutage.stopped', '{{distro}} is stopped', {
        distro: outage.hostLabel
      }),
      action: {
        label: t('components.native-chat.hostOutage.start', 'Start'),
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
      ? t('components.native-chat.hostOutage.offline', '{{hostName}} is offline', {
          hostName: outage.hostLabel
        })
      : t('components.native-chat.hostOutage.reconnecting', '{{hostName}} is reconnecting…', {
          hostName: outage.hostLabel
        }),
    ...(outage.canReconnect
      ? {
          action: {
            label: t('components.native-chat.hostOutage.reconnect', 'Reconnect'),
            onClick: () => reconnect(outage.environmentId, false),
            disabled: connecting
          }
        }
      : {})
  }
}
