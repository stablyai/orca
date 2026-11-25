// A bot's Tidy-up as its host has it: the setting, the last run's summary, Tidy now and Undo.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BOT_VIEW_KINDS } from '../../../../shared/bots/bot-change-scope'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import { callBotRpc, type BotRef } from '@/lib/bot-hosts'
import type { BotTidyUpView } from '../../../../shared/bots/bot-tidy-up'

/** While a run is going, how often its end is looked for. */
const RUNNING_POLL_MS = 5_000

function tidyNowRefusalText(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (code.includes('tidy_now_running')) {
    return translate('settings.bots.tidyUp.nowRunning', 'Already tidying.')
  }
  if (code.includes('tidy_now_busy')) {
    return translate(
      'settings.bots.tidyUp.nowBusy',
      'A chat is still working. Try again when it’s done.'
    )
  }
  if (code.includes('tidy_now_paused')) {
    return translate('settings.bots.tidyUp.nowPaused', 'Turn the bot on to tidy its memory.')
  }
  return translate('settings.bots.tidyUp.nowFailed', 'Could not start a tidy-up. Try again.')
}

export type BotTidyUpControls = {
  view: BotTidyUpView | null
  tidyNow: () => Promise<void>
  /** Puts MEMORY.md back as it was before the tidy-up the owner reviewed, by its History row. */
  undo: (rowId: string) => Promise<void>
}

export function useBotTidyUp(bot: BotRef): BotTidyUpControls {
  const { hostId, id: botId } = bot
  const [view, setView] = useState<BotTidyUpView | null>(null)
  const reads = useRef(0)
  // The bot this hook shows now, so an Undo answered after a switch never lands on another bot.
  const shown = useRef({ hostId, botId })
  // Before paint, so no Undo answer handled after a switch still sees the old bot.
  useLayoutEffect(() => {
    shown.current = { hostId, botId }
  }, [hostId, botId])

  const load = useCallback(async (): Promise<void> => {
    // Only the latest read lands, so an older one finishing late cannot overwrite it.
    const read = ++reads.current
    try {
      const { tidyUp } = await callBotRpc<{ tidyUp: BotTidyUpView }>(
        { hostId },
        'bots.tidyUp.get',
        { botId }
      )
      if (read === reads.current) {
        setView(tidyUp)
      }
    } catch (error) {
      console.error('Failed to read Tidy-up:', error)
    }
  }, [botId, hostId])

  useEffect(() => {
    void load()
    return onBotsChanged(() => void load(), hostId, { botId, kinds: BOT_VIEW_KINDS })
  }, [load, hostId, botId])

  const running = view?.running === true
  useEffect(() => {
    if (!running) {
      return
    }
    const timer = setInterval(() => void load(), RUNNING_POLL_MS)
    return () => clearInterval(timer)
  }, [running, load])

  const tidyNow = useCallback(async (): Promise<void> => {
    try {
      await callBotRpc({ hostId }, 'bots.tidyUp.now', { botId })
    } catch (error) {
      toast.message(tidyNowRefusalText(error))
    }
    await load()
  }, [botId, hostId, load])

  const undo = useCallback(
    async (rowId: string): Promise<void> => {
      const stillShown = (): boolean =>
        shown.current.hostId === hostId && shown.current.botId === botId
      try {
        const { undone, tidyUp } = await callBotRpc<{ undone: boolean; tidyUp: BotTidyUpView }>(
          { hostId },
          'bots.tidyUp.undo',
          { botId, rowId }
        )
        if (!stillShown()) {
          return
        }
        // Newer than any read still out: none of them may replace it.
        reads.current += 1
        setView(tidyUp)
        if (!undone) {
          toast.message(
            translate(
              'settings.bots.tidyUp.undoSuperseded',
              'Memory changed since this tidy-up, so it was left as it is.'
            )
          )
        }
      } catch (error) {
        if (!stillShown()) {
          return
        }
        if (error instanceof Error && error.message.includes('tidy_up_stale')) {
          toast.message(
            translate(
              'settings.bots.tidyUp.undoStale',
              'A newer tidy-up ran since. Review it before undoing.'
            )
          )
        } else {
          console.error('Failed to undo a tidy-up:', error)
          toast.error(translate('settings.bots.tidyUp.undoFailed', 'Could not undo the tidy-up.'))
        }
        await load()
      }
    },
    [botId, hostId, load]
  )

  return { view, tidyNow, undo }
}
