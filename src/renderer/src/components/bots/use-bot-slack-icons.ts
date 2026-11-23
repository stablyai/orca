// Draws each Slack-linked bot's colored or dressed mascot once per look, for the host to send as its Slack
// icon. Until a window draws it (a host with none open, a look set from a phone or the CLI), the host sends
// the plain mascot; two windows drawing the same look send the same picture.
import { useEffect } from 'react'
import { readBots, subscribeToBotChanges } from '@/lib/bot-catalog'
import { readBotHostState } from '@/lib/bot-catalog-snapshot'
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
// Hosts seen offline: their looks are asked about again once they are back, as another client may have
// replaced the icon meanwhile.
const offline = new Set<string>()

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
  if (readBotHostState(bot.hostId) === 'offline') {
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
    readBotHostState(bot.hostId) === 'offline' ||
    !botHostHas(bot.hostId, BOTS_SLACK_ICON_RUNTIME_CAPABILITY)
  ) {
    return
  }
  handled.set(key, look)
  const queued = (queues.get(bot.hostId) ?? Promise.resolve()).then(() => publish(bot, look))
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
      publishBotSlackIcon({ ...saved, hostId })
    }
    return saved
  }
}

function publishLooks(bots: readonly Bot[]): void {
  const back = new Set<string>()
  for (const bot of bots) {
    const isOffline = readBotHostState(bot.hostId) === 'offline'
    if (isOffline) {
      offline.add(bot.hostId)
    } else if (offline.has(bot.hostId)) {
      back.add(bot.hostId)
    }
  }
  for (const hostId of back) {
    offline.delete(hostId)
  }
  for (const bot of bots) {
    if (back.has(bot.hostId)) {
      handled.delete(botRefKey(bot))
    }
    publishBotSlackIcon(bot)
  }
}

/** Run where the bots are already listed (the sidebar's Bots), so it never loads them on its own. Each
 *  bots notice runs it, a host's reconnect too, which keeps the same bots list. */
export function useBotSlackIcons(): void {
  useEffect(() => {
    const run = (): void => publishLooks(readBots())
    run()
    return subscribeToBotChanges(run)
  }, [])
}
