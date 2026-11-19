// A chat chip's live status, read fresh each time its preview opens (one item read); the open Items
// tab's last read shows until it lands. No subscription, no timer.
import { useEffect, useState } from 'react'
import type { BotRef } from '@/lib/bot-hosts'
import { botItemLastRead, showBotItem } from '@/components/bots/items/use-bot-items'
import type { BotItem } from '../../../../../shared/bots/bot-items'

function readItem(bot: BotRef, uid: string): Promise<BotItem | null> {
  return showBotItem(bot, uid, { newest: true })
    .then((page) => page.item)
    .catch((error: unknown) => {
      console.warn('[bots] items: reading a chip’s item failed', error)
      return null
    })
}

export function useBotItemChipPreview(bot: BotRef | null, uid: string): BotItem | null {
  const [fetched, setFetched] = useState<BotItem | null>(null)
  const known = bot ? botItemLastRead(bot, uid) : null
  const { hostId, id } = bot ?? { hostId: null, id: null }
  useEffect(() => {
    if (!id) {
      return
    }
    let live = true
    void readItem({ hostId, id }, uid).then((item) => {
      if (live) {
        setFetched(item)
      }
    })
    return () => {
      live = false
    }
  }, [hostId, id, uid])
  return fetched ?? known
}
