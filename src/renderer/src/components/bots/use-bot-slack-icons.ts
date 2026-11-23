// Draws each Slack-linked bot's colored or dressed mascot once per look, for the host to send as its Slack
// icon. Until a window showing Bots draws it (a host with none open, a look set from a phone or the CLI),
// the host sends the plain mascot; two windows drawing the same look send the same picture.
import { useEffect } from 'react'
import { botSlackIconWanted, uploadBotSlackIcon } from '@/lib/bot-catalog'
import { botRefKey } from '@/lib/bot-hosts'
import { botHostHas } from '@/lib/bot-host-status'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { BOTS_SLACK_ICON_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import { wornBotOutfit } from '../../../../shared/bots/bot-avatar-outfit'
import { botSlackIconLook } from '../../../../shared/bots/bot-slack-icon'
import { drawBotSlackIcon } from './bot-slack-icon-raster'

// Per bot, the look asked about or drawn this session; a failed one is let go for the next bots read.
const handled = new Map<string, string>()
// One drawing at a time, so a roster of new looks never decodes many pictures at once.
let queue: Promise<void> = Promise.resolve()

async function publish(bot: Bot, look: string): Promise<void> {
  try {
    const parsed = parseBotAvatar(bot.avatar)
    if (parsed?.kind !== 'mascot' || !(await botSlackIconWanted(bot, look))) {
      return
    }
    const png = await drawBotSlackIcon(
      parsed.id,
      bot.avatarColor ?? null,
      wornBotOutfit(bot.avatarOutfit)
    )
    if (!png) {
      forget(bot, look)
      return
    }
    await uploadBotSlackIcon(bot, look, png)
  } catch (error) {
    forget(bot, look)
    console.warn('[bots] could not draw the Slack icon', error)
  }
}

function forget(bot: Bot, look: string): void {
  if (handled.get(botRefKey(bot)) === look) {
    handled.delete(botRefKey(bot))
  }
}

function publishLooks(bots: readonly Bot[]): void {
  for (const bot of bots) {
    const look = botSlackIconLook(bot)
    // An outfit from a newer Orca is left to a window that can draw it.
    const drawable = !bot.avatarOutfit || wornBotOutfit(bot.avatarOutfit) !== null
    if (!look || !drawable || !(bot.slack || bot.github)) {
      continue
    }
    const key = botRefKey(bot)
    if (handled.get(key) === look || !botHostHas(bot.hostId, BOTS_SLACK_ICON_RUNTIME_CAPABILITY)) {
      continue
    }
    handled.set(key, look)
    queue = queue.then(() => publish(bot, look))
  }
}

/** Run where the bots are already listed (the sidebar's Bots), so it never reads them on its own. */
export function useBotSlackIcons(bots: readonly Bot[]): void {
  useEffect(() => publishLooks(bots), [bots])
}
