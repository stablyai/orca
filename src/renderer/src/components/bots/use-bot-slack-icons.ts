// Draws each Slack-linked bot's colored or dressed mascot once per look, for the host to send as its Slack
// icon. Until a window draws it (a host with none open, a look set from a phone or the CLI), the host sends
// the plain mascot; two windows drawing the same look keep one picture.
import { useEffect } from 'react'
import { readBots, readBotsEnabled, subscribeToBotChanges, useBotsEnabled } from '@/lib/bot-catalog'
import { onBotHostCameBack } from '@/lib/bot-host-link-read'
import { readBotHostState, readLiveBotHostIds } from '@/lib/bot-catalog-snapshot'
import { botRefKey } from '@/lib/bot-hosts'
import { botHostHas } from '@/lib/bot-host-status'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { BOTS_SLACK_ICON_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import { wornBotOutfit } from '../../../../shared/bots/bot-avatar-outfit'
import { botSlackIconLook } from '../../../../shared/bots/bot-slack-icon'
import { slackIconFailures } from './bot-slack-icon-failures'
import { drawBotSlackIcon } from './bot-slack-icon-raster'
import { botSlackIconWanted, resendBotSlackIcon, uploadBotSlackIcon } from './bot-slack-icon-rpc'

// Per bot, the look asked about or drawn this session; a failed one is let go for the next bots read.
const handled = new Map<string, { look: string; attempt: number }>()
// Each attempt's number, so a late failure of an older one never lets a newer one go.
let attempts = 0
// Per host, one drawing at a time, so a stalled host never holds up another's; waiting, only each bot's
// latest attempt, so a stalled drawing never piles up more than one per bot behind it.
type Attempt = { bot: Bot; look: string; attempt: number }
const pending = new Map<string, Map<string, Attempt>>()
const running = new Set<string>()
// Per bot, failed attempts at its look: a failure is tried again on the next notices, at most this many times,
// until its record changes, its host comes back, or bots are turned back on.
const MAX_TRIES = 3
const failures = slackIconFailures
// Bots whose Try again was pressed: an icon the host already keeps is sent to the cloud again too.
const forced = new Set<string>()
// What the last run saw, so a notice that changed neither the bots nor which hosts are live (a Needs You
// count) costs nothing, and a bot record it already looked at is skipped.
let seenBots: readonly Bot[] | null = null
let seenLive: readonly string[] | null = null
// Bot records already looked at; a failed one is let go so the next notice tries it again.
const seen = new WeakSet<Bot>()
// Bots whose attempt failed, looked at again on the next run whatever their record.
const retry = new Set<string>()

// Lets a failed or outdated attempt go; the next bots notice, of any kind, looks at the bot again.
function forget(bot: Bot, attempt: number): void {
  const key = botRefKey(bot)
  const entry = handled.get(key)
  if (entry?.attempt !== attempt) {
    return
  }
  handled.delete(key)
  const before = failures.get(key)
  const count = before?.look === entry.look ? before.count + 1 : 1
  failures.set(key, { look: entry.look, count })
  if (count < MAX_TRIES) {
    // By id: the record that failed may be a save's reply, not the listed one the next run sees.
    retry.add(key)
    seenBots = null
  }
}

// Checked after each wait: a newer look, bots turned off, or the host gone makes the rest of this one moot.
function stillCurrent(bot: Bot, attempt: number): boolean {
  return (
    handled.get(botRefKey(bot))?.attempt === attempt &&
    readBotsEnabled() &&
    readBotHostState(bot.hostId) === 'live'
  )
}

function pump(hostId: string): void {
  const jobs = pending.get(hostId)
  const next = running.has(hostId) ? undefined : jobs?.entries().next().value
  if (!next) {
    if (jobs?.size === 0) {
      pending.delete(hostId)
    }
    return
  }
  const [key, job] = next
  jobs?.delete(key)
  running.add(hostId)
  void publish(job.bot, job.look, job.attempt).finally(() => {
    running.delete(hostId)
    pump(hostId)
  })
}

async function publish(bot: Bot, look: string, attempt: number): Promise<void> {
  // A newer look took its place while it waited, or its host went away: that one, or the return, asks again.
  if (handled.get(botRefKey(bot))?.attempt !== attempt) {
    return
  }
  // Bots turned off while it waited: nothing more is drawn or sent.
  if (!readBotsEnabled()) {
    forget(bot, attempt)
    return
  }
  if (readBotHostState(bot.hostId) !== 'live') {
    forget(bot, attempt)
    return
  }
  try {
    const parsed = parseBotAvatar(bot.avatar)
    const want = parsed?.kind === 'mascot' ? await botSlackIconWanted(bot, look) : null
    if (!want?.current) {
      // The host hasn't saved this look yet (a window's own edit): asked again on the next bots read.
      forget(bot, attempt)
      return
    }
    if (!want.wanted || parsed?.kind !== 'mascot') {
      // Kept already: a Try again sends it on, in case it was the send that failed.
      if (forced.delete(botRefKey(bot)) && !(await resendBotSlackIcon(bot))) {
        forget(bot, attempt)
        return
      }
      failures.delete(botRefKey(bot))
      return
    }
    if (!stillCurrent(bot, attempt)) {
      return
    }
    const png = await drawBotSlackIcon(
      parsed.id,
      bot.avatarColor ?? null,
      wornBotOutfit(bot.avatarOutfit)
    )
    if (!png) {
      forget(bot, attempt)
      return
    }
    if (!stillCurrent(bot, attempt)) {
      return
    }
    if (await uploadBotSlackIcon(bot, look, png)) {
      forced.delete(botRefKey(bot))
      failures.delete(botRefKey(bot))
    } else {
      // The look changed on the host meanwhile: picking it again asks again.
      forget(bot, attempt)
    }
  } catch (error) {
    forget(bot, attempt)
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
  const failed = failures.get(key)
  if (
    handled.get(key)?.look === look ||
    // Out of tries for this look until its record changes or its host comes back.
    (failed?.look === look && failed.count >= MAX_TRIES) ||
    readBotHostState(bot.hostId) !== 'live' ||
    !botHostHas(bot.hostId, BOTS_SLACK_ICON_RUNTIME_CAPABILITY)
  ) {
    return
  }
  attempts += 1
  const attempt = attempts
  handled.set(key, { look, attempt })
  const jobs = pending.get(bot.hostId) ?? new Map<string, Attempt>()
  jobs.set(key, { bot, look, attempt })
  pending.set(bot.hostId, jobs)
  pump(bot.hostId)
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
      failures.delete(botRefKey(bot))
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
  const liveChanged = live !== seenLive
  const listChanged = bots !== seenBots
  seenBots = bots
  seenLive = live
  for (const bot of bots) {
    if (liveChanged || !seen.has(bot) || (retry.size > 0 && retry.delete(botRefKey(bot)))) {
      // A changed record may follow edits this window never saw (another client's look replacing this
      // one's icon), so its host is asked again: one check per changed bot, never the whole roster.
      if (!seen.has(bot)) {
        handled.delete(botRefKey(bot))
        failures.delete(botRefKey(bot))
      }
      seen.add(bot)
      publishBotSlackIcon(bot)
    }
  }
  // A deleted bot, or one on an unpaired host, keeps nothing here, even when others took its place in a
  // list of the same length: once per changed list, before any of its jobs runs again.
  if (listChanged) {
    const listed = new Set(bots.map(botRefKey))
    for (const key of handled.keys()) {
      if (!listed.has(key)) {
        handled.delete(key)
      }
    }
    for (const key of retry) {
      if (!listed.has(key)) {
        retry.delete(key)
      }
    }
    for (const key of failures.keys()) {
      if (!listed.has(key)) {
        failures.delete(key)
      }
    }
    for (const key of forced) {
      if (!listed.has(key)) {
        forced.delete(key)
      }
    }
    for (const jobs of pending.values()) {
      for (const key of jobs.keys()) {
        if (!listed.has(key)) {
          jobs.delete(key)
        }
      }
    }
  }
}

// Back from offline, or its event stream back after a gap: another client may have replaced its icons.
// Only that host's bots are asked about again; the others keep what they had.
function hostCameBack(hostId: ExecutionHostId): void {
  if (!readBotsEnabled()) {
    return
  }
  for (const bot of readBots()) {
    if (bot.hostId === hostId) {
      const key = botRefKey(bot)
      handled.delete(key)
      failures.delete(key)
      seen.add(bot)
      publishBotSlackIcon(bot)
    }
  }
}

// Coming back to the window is a real step: each failed icon is tried again, its count of tries started over.
function retryFailed(): void {
  if (failures.size === 0) {
    return
  }
  for (const key of failures.keys()) {
    retry.add(key)
    failures.delete(key)
  }
  seenBots = null
  publishLooks()
}

/** The settings' Try again: the bot's icon is asked about, drawn and sent again now. With its host away it
 *  does nothing, and the note stays: the host's return tries again. */
export function retryBotSlackIcon(bot: Bot): void {
  if (readBotHostState(bot.hostId) !== 'live') {
    return
  }
  forced.add(botRefKey(bot))
  failures.delete(botRefKey(bot))
  handled.delete(botRefKey(bot))
  publishBotSlackIcon(bot)
}

/** For the window: follows the bots list another surface loaded, and never loads it itself. Turning
 *  bots back on runs it too, as the list may have changed while they were off. */
export function useBotSlackIcons(): void {
  const enabled = useBotsEnabled()
  useEffect(() => {
    if (!enabled) {
      return
    }
    // Another client may have replaced icons while bots were off here: every look is asked about again.
    handled.clear()
    failures.clear()
    seenBots = null
    seenLive = null
    publishLooks()
    const stopBots = subscribeToBotChanges(publishLooks)
    const stopCameBack = onBotHostCameBack(hostCameBack)
    window.addEventListener('focus', retryFailed)
    return () => {
      stopBots()
      stopCameBack()
      window.removeEventListener('focus', retryFailed)
      // Off, nothing here is kept: no list, no waiting attempts, and the one running stops at its next check.
      seenBots = null
      seenLive = null
      handled.clear()
      failures.clear()
      retry.clear()
      pending.clear()
      forced.clear()
    }
  }, [enabled])
}
