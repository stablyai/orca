// The bot settings picture's tile color: it saves on its own, the latest pick after a pause, and until it
// lands it is shown as picked. While a save is due or in flight the picture ledger has it open, so a
// picture generated meanwhile waits for its revision.
import { useRef, useState } from 'react'
import { botRefKey } from '@/lib/bot-hosts'
import {
  beginBotPictureOp,
  noteBotPictureAck,
  noteBotPictureChoice,
  noteBotPictureFailure
} from '@/components/bots/bot-picture-ops'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { BOT_PICTURE_SAVE_DELAY_MS } from './bot-picture-setting-choices'

export function useBotPictureColor(
  bot: Bot,
  update: (updates: BotUpdateParams['updates']) => Promise<Bot | null>
): {
  /** The color shown; null is the mascot's own sky blue. */
  color: string | null
  pickColor: (color: string | null) => void
  /** Saves a pick still waiting on its pause (Settings closing). */
  flush: () => void
} {
  const key = botRefKey(bot)
  const [picked, setPicked] = useState<{ color: string | null } | null>(null)
  const timer = useRef<{ timer: ReturnType<typeof setTimeout>; save: () => void } | null>(null)
  const saves = useRef(0)
  const op = useRef<{ end: () => void } | null>(null)
  const syncOp = (): void => {
    const busy = timer.current !== null || saves.current > 0
    if (busy && !op.current) {
      op.current = beginBotPictureOp(key)
    } else if (!busy && op.current) {
      const ended = op.current
      op.current = null
      ended.end()
    }
  }
  const save = (color: string | null): void => {
    timer.current = null
    saves.current += 1
    syncOp()
    void update({ avatarColor: color })
      .then((saved) => {
        if (saved) {
          noteBotPictureAck(key, saved.avatarRevision)
        } else {
          noteBotPictureFailure(key)
        }
      })
      .finally(() => {
        saves.current -= 1
        syncOp()
        setPicked((now) => (now?.color === color ? null : now))
      })
  }
  return {
    color: picked ? picked.color : (bot.avatarColor ?? null),
    pickColor: (color) => {
      noteBotPictureChoice(key)
      setPicked({ color })
      if (timer.current) {
        clearTimeout(timer.current.timer)
      }
      const pending = (): void => save(color)
      timer.current = { timer: setTimeout(pending, BOT_PICTURE_SAVE_DELAY_MS), save: pending }
      syncOp()
    },
    flush: () => {
      if (timer.current) {
        clearTimeout(timer.current.timer)
        timer.current.save()
      }
    }
  }
}
