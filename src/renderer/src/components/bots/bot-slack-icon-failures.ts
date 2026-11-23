// The Slack icons this window failed to draw or send, by bot, so its settings can say so and offer to try
// again: kept for the session only, cleared once the icon goes or the bot's look changes.
import { useSyncExternalStore } from 'react'
import { botRefKey } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'
import { botSlackIconLook } from '../../../../shared/bots/bot-slack-icon'

type Failure = { look: string; count: number }

const listeners = new Set<() => void>()

// A map that tells its listeners when it changes, so a settings row redraws only on a failure or its end.
class FailureMap extends Map<string, Failure> {
  override set(key: string, value: Failure): this {
    super.set(key, value)
    listeners.forEach((listener) => listener())
    return this
  }

  override delete(key: string): boolean {
    const had = super.delete(key)
    if (had) {
      listeners.forEach((listener) => listener())
    }
    return had
  }

  override clear(): void {
    if (this.size > 0) {
      super.clear()
      listeners.forEach((listener) => listener())
    }
  }
}

/** Per bot (by botRefKey), its failed attempts at a look. */
export const slackIconFailures = new FailureMap()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether this window's last try at the bot's current look failed. */
export function useBotSlackIconFailed(bot: Bot): boolean {
  const read = (): boolean => {
    const look = botSlackIconLook(bot)
    return look !== null && slackIconFailures.get(botRefKey(bot))?.look === look
  }
  return useSyncExternalStore(subscribe, read, read)
}
