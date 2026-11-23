// Draws each Slack-linked bot's colored or dressed mascot once per look, for the host to send as its Slack
// icon. A host with no window open (or a look set from a phone or the CLI) sends the plain mascot until a
// window draws it; two windows drawing the same look send the same picture.
import { useEffect } from 'react'
import { botSlackIconWanted, uploadBotSlackIcon, useBots } from '@/lib/bot-catalog'
import { botRefKey } from '@/lib/bot-hosts'
import { botHostHas } from '@/lib/bot-host-status'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { BOTS_SLACK_ICON_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import { wornBotOutfit } from '../../../../shared/bots/bot-avatar-outfit'
import { botSlackIconLook } from '../../../../shared/bots/bot-slack-icon'
import { drawBotSlackIcon } from './bot-slack-icon-raster'

// Looks asked about or drawn this session, by bot and look; a failed one is let go for the next bots read.
const handled = new Set<string>()
// One drawing at a time, so a roster of new looks never decodes many pictures at once.
let queue: Promise<void> = Promise.resolve()

async function publish(bot: Bot, look: string, key: string): Promise<void> {
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
      handled.delete(key)
      return
    }
    await uploadBotSlackIcon(bot, look, png)
  } catch (error) {
    handled.delete(key)
    console.warn('[bots] could not draw the Slack icon', error)
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
    const key = `${botRefKey(bot)}\u0000${look}`
    if (handled.has(key) || !botHostHas(bot.hostId, BOTS_SLACK_ICON_RUNTIME_CAPABILITY)) {
      continue
    }
    handled.add(key)
    queue = queue.then(() => publish(bot, look, key))
  }
}

export function BotSlackIconPublisher(): null {
  const bots = useBots()
  useEffect(() => publishLooks(bots), [bots])
  return null
}
