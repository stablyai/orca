// Draws each Slack-linked bot's colored or dressed mascot once per look, for the host to send as its Slack
// icon. Until a window draws it (a host with none open, a look set from a phone or the CLI), the host sends
// the plain mascot; two windows drawing the same look keep one picture.
import { useEffect } from 'react'
import { readBots, readBotsEnabled, subscribeToBotChanges } from '@/lib/bot-catalog'
import { readBotHostState, readLiveBotHostIds } from '@/lib/bot-catalog-snapshot'
import { botRefKey, callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { botHostHas } from '@/lib/bot-host-status'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import { BOTS_SLACK_ICON_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import { wornBotOutfit } from '../../../../shared/bots/bot-avatar-outfit'
import { botSlackIconLook } from '../../../../shared/bots/bot-slack-icon'
import { drawBotSlackIcon } from './bot-slack-icon-raster'

// Per bot, the look asked about or drawn this session; a failed one is let go for the next bots read.
const handled = new Map<string, string>()
// Per host, one drawing at a time, so a stalled host never holds up another's.
const queues = new Map<string, Promise<void>>()
// What the last run saw, so a notice that changed neither the bots nor which hosts are live (a Needs You
// count) costs nothing; a host back from offline has its looks asked about again, as another client may
// have replaced its icon meanwhile.
let seenBots: readonly Bot[] | null = null
let seenLive: readonly string[] | null = null

// Whether the host wants `look` drawn, and whether `look` is the bot's look there yet.
function botSlackIconWanted(
  bot: BotRef,
  look: string
): Promise<{ wanted: boolean; current: boolean }> {
  return callBotRpc(bot, 'bots.avatar.slackIcon.wanted', { botId: bot.id, look })
}

// False when the host's look changed since and it dropped the drawing.
async function uploadBotSlackIcon(bot: BotRef, look: string, png: string): Promise<boolean> {
  const { stored } = await callBotRpc<{ stored: boolean }>(bot, 'bots.avatar.slackIcon.upload', {
    botId: bot.id,
    look,
    png
  })
  return stored
}

function forget(bot: Bot, look: string): void {
  if (handled.get(botRefKey(bot)) === look) {
    handled.delete(botRefKey(bot))
  }
}

async function publish(bot: Bot, look: string): Promise<void> {
  // A newer look took its place while it waited, or its host went away: that one, or the return, asks again.
  if (handled.get(botRefKey(bot)) !== look) {
    return
  }
  if (readBotHostState(bot.hostId) !== 'live') {
    forget(bot, look)
    return
  }
  try {
    const parsed = parseBotAvatar(bot.avatar)
    const want = parsed?.kind === 'mascot' ? await botSlackIconWanted(bot, look) : null
    if (!want?.current) {
      // The host hasn't saved this look yet (a window's own edit): asked again on the next bots read.
      forget(bot, look)
      return
    }
    if (!want.wanted || parsed?.kind !== 'mascot') {
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
    if (!(await uploadBotSlackIcon(bot, look, png))) {
      // The look changed on the host meanwhile: picking it again asks again.
      forget(bot, look)
    }
  } catch (error) {
    forget(bot, look)
    console.warn('[bots] could not draw the Slack icon', error)
  }
}

/** Asks the bot's host for its Slack icon if this look is new here; a no-op for any other bot. */
export function publishBotSlackIcon(bot: Bot): void {
  const look = botSlackIconLook(bot)
  // An outfit from a newer Orca is left to a window that can draw it.
  const drawable = !bot.avatarOutfit || wornBotOutfit(bot.avatarOutfit) !== null
  if (!look || !drawable || !(bot.slack || bot.github)) {
    return
  }
  const key = botRefKey(bot)
  if (
    handled.get(key) === look ||
    readBotHostState(bot.hostId) !== 'live' ||
    !botHostHas(bot.hostId, BOTS_SLACK_ICON_RUNTIME_CAPABILITY)
  ) {
    return
  }
  handled.set(key, look)
  const queued: Promise<void> = (queues.get(bot.hostId) ?? Promise.resolve())
    .then(() => publish(bot, look))
    .finally(() => {
      // A settled queue is let go, so an unpaired host keeps nothing here.
      if (queues.get(bot.hostId) === queued) {
        queues.delete(bot.hostId)
      }
    })
  queues.set(bot.hostId, queued)
}

/** `save`, then the saved bot's icon published, for a window's own picture edits. */
export function withSlackIconPublish<T>(
  save: (updates: T) => Promise<Bot | null>,
  hostId: Bot['hostId']
): (updates: T) => Promise<Bot | null> {
  return async (updates) => {
    const saved = await save(updates)
    if (saved) {
      // Saved here, the look is asked about again: another window may have replaced its icon since.
      const bot = { ...saved, hostId }
      handled.delete(botRefKey(bot))
      publishBotSlackIcon(bot)
    }
    return saved
  }
}

function publishLooks(): void {
  if (!readBotsEnabled()) {
    return
  }
  const bots = readBots()
  const live = readLiveBotHostIds()
  if (bots === seenBots && live === seenLive) {
    return
  }
  const before = new Set(seenLive ?? live)
  const back = new Set(live.filter((hostId) => !before.has(hostId)))
  const listed = bots !== seenBots ? new Set(bots.map(botRefKey)) : null
  seenBots = bots
  seenLive = live
  // A deleted bot, or one on an unpaired host, keeps nothing here.
  if (listed) {
    for (const key of handled.keys()) {
      if (!listed.has(key)) {
        handled.delete(key)
      }
    }
  }
  for (const bot of bots) {
    if (back.has(bot.hostId)) {
      handled.delete(botRefKey(bot))
    }
    publishBotSlackIcon(bot)
  }
}

/** For the window: follows the bots list another surface loaded, and never loads it itself. Each list
 *  change, and each host's reconnect, which keeps the same list, is a run. */
export function useBotSlackIcons(): void {
  useEffect(() => {
    publishLooks()
    return subscribeToBotChanges(publishLooks)
  }, [])
}
