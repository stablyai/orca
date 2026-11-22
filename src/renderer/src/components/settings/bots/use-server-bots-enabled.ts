import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { botHostTarget } from '@/lib/bot-hosts'
import { refreshBotHost } from '@/lib/bot-host-refresh'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { isBotsEnabled } from '../../../../../shared/bots-switch'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'

type SettingsAnswer = { settings: Partial<GlobalSettings> }

/**
 * A paired server's own "Enable bots", which every device and phone paired to it follows; null
 * until read. Turning it changes the server's setting, not this computer's.
 */
export function useServerBotsEnabled(
  hostId: ExecutionHostId,
  hostName: string
): { enabled: boolean | null; set: (enabled: boolean) => Promise<void> } {
  const t = useTranslate()
  const [read, setRead] = useState<{ hostId: ExecutionHostId; enabled: boolean } | null>(null)
  useEffect(() => {
    let current = true
    void callRuntimeRpc<SettingsAnswer>(botHostTarget(hostId), 'settings.get').then(
      (answer) => {
        if (current) {
          setRead({ hostId, enabled: isBotsEnabled(answer.settings) })
        }
      },
      () => undefined
    )
    return () => {
      current = false
    }
  }, [hostId])
  return {
    enabled: read?.hostId === hostId ? read.enabled : null,
    set: async (enabled) => {
      try {
        const answer = await callRuntimeRpc<SettingsAnswer>(
          botHostTarget(hostId),
          'settings.update',
          { botsEnabled: enabled }
        )
        setRead({ hostId, enabled: isBotsEnabled(answer.settings) })
        await refreshBotHost(hostId)
      } catch (error) {
        toast.error(
          t('settings.bots.serverEnableFailed', 'Couldn’t change bots on {{host}}.', {
            host: hostName
          }),
          { description: error instanceof Error ? error.message : String(error) }
        )
      }
    }
  }
}
