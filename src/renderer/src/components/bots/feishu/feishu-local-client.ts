import { onBotsChanged } from '@/lib/bots-changed-window-event'
import { useEffect, useState } from 'react'
import { botTarget } from '@/lib/bot-hosts'
import { botHostHas } from '@/lib/bot-host-status'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { BOTS_FEISHU_LOCAL_CAPABILITY } from '../../../../../shared/bot-runtime-capabilities'
import type { Bot } from '../../../../../shared/bot-types'
import type { FeishuLocalState } from '../../../../../shared/bots/feishu-local'

export function feishuCall<T>(
  bot: Bot,
  method: string,
  params: unknown = { botId: bot.id }
): Promise<T> {
  return callRuntimeRpc<T>(botTarget(bot), `bots.feishuLocal.${method}`, params)
}
export function useFeishuState(bot: Bot | null) {
  const [read, setRead] = useState<{ key: string; state: FeishuLocalState | null } | null>(null)
  const key = bot ? JSON.stringify([bot.hostId, bot.id]) : ''
  useEffect(() => {
    if (!bot || !botHostHas(bot.hostId, BOTS_FEISHU_LOCAL_CAPABILITY)) {
      return
    }
    let active = true
    let generation = 0
    const refresh = (): void => {
      generation += 1
      const id = generation
      void feishuCall<FeishuLocalState>(bot, 'state')
        .catch(() => null)
        .then((state) => {
          if (active && id === generation) {
            setRead({ key, state })
          }
        })
    }
    refresh()
    const release = onBotsChanged(refresh, bot.hostId, {
      botId: bot.id,
      kinds: ['settings', 'bot']
    })
    return () => {
      active = false
      release()
    }
  }, [bot, key])
  return read?.key === key ? read.state : undefined
}
