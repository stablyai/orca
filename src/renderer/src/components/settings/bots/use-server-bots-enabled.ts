import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { botHostTarget } from '@/lib/bot-hosts'
import { refreshBotHost } from '@/lib/bot-host-refresh'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { isBotsEnabled } from '../../../../../shared/bots-switch'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'

type SettingsAnswer = { settings: Partial<GlobalSettings>; botsBlockedByTeam?: boolean }

/**
 * A paired server's own "Enable bots", which every device and phone paired to it follows; null
 * until read. Turning it changes the server's setting, not this computer's.
 */
export function useServerBotsEnabled(
  hostId: ExecutionHostId,
  hostName: string
): { enabled: boolean | null; blocked: boolean; set: (enabled: boolean) => Promise<void> } {
  const t = useTranslate()
  const [read, setRead] = useState<{ hostId: ExecutionHostId; answer: SettingsAnswer } | null>(null)
  const answer = read?.hostId === hostId ? read.answer : null
  const blocked = answer?.botsBlockedByTeam === true
  useEffect(() => {
    let current = true
    let requestId = 0
    const refresh = (): void => {
      const id = requestId + 1
      requestId = id
      void callRuntimeRpc<SettingsAnswer>(botHostTarget(hostId), 'settings.get').then(
        (latest) => {
          if (current && id === requestId) {
            setRead({ hostId, answer: latest })
          }
        },
        () => undefined
      )
    }
    const unsubscribe = onBotsChanged(refresh, hostId, { kinds: ['settings'] })
    refresh()
    return () => {
      current = false
      unsubscribe()
    }
  }, [hostId])
  return {
    enabled: answer ? !blocked && isBotsEnabled(answer.settings) : null,
    blocked,
    set: async (enabled) => {
      if (blocked) {
        return
      }
      try {
        const updated = await callRuntimeRpc<SettingsAnswer>(
          botHostTarget(hostId),
          'settings.update',
          { botsEnabled: enabled }
        )
        setRead({ hostId, answer: updated })
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
