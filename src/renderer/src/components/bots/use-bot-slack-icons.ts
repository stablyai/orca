// Draws each Slack-linked bot's colored or dressed mascot once per look, for the host to send as its Slack
// icon. Until a window draws it (a host with none open, a look set from a phone or the CLI), the host sends
// the plain mascot; two windows drawing the same look keep one picture. A try that fails is tried again only
// on a real step: the bot's record changing, its host coming back, bots turned back on, the window focused,
// or a reload. Nothing here runs on a timer.
import { useEffect } from 'react'
import { readBotsEnabled, subscribeToBotChanges, useBotsEnabled } from '@/lib/bot-catalog'
import { onBotHostCameBack } from '@/lib/bot-host-link-read'
import { BOTS_CHANGED_EVENT } from '@/lib/bots-changed-window-event'
import { readBotHostIds, readBotHostState, readHostBots } from '@/lib/bot-catalog-snapshot'
import { botRefKey } from '@/lib/bot-hosts'
import { botHostHas } from '@/lib/bot-host-status'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import {
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { BOTS_SLACK_ICON_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import { wornBotOutfit } from '../../../../shared/bots/bot-avatar-outfit'
import { botSlackIconLook } from '../../../../shared/bots/bot-slack-icon'
import { allowOutfitReadsAgain } from './bot-outfit-art'
import { drawBotSlackIcon } from './bot-slack-icon-raster'
import { botSlackIconWanted, uploadBotSlackIcon } from './bot-slack-icon-rpc'

// Per bot, the look asked about or drawn this session, with its attempt's number, so a late end of an older
// attempt never lets a newer one go.
const handled = new Map<string, { look: string; attempt: number }>()
let attempts = 0
// Per host, one drawing at a time, so a stalled host never holds up another's; waiting, only each bot's
// latest attempt, so a stalled drawing never piles up more than one per bot behind it.
type Attempt = { bot: Bot; look: string; attempt: number }
const pending = new Map<string, Map<string, Attempt>>()
const running = new Set<string>()
// Per bot, the look its last try failed at: not tried again until a real step clears it.
// Kept by host, so one host's notice looks only at its own.
// `off`: the host said the look wasn't current (its own bots off), which only its settings change mends.
type Failure = { look: string; bot: Bot; off: boolean }
const failures = new Map<ExecutionHostId, Map<string, Failure>>()

function failureOf(bot: Bot): Failure | undefined {
  return failures.get(bot.hostId)?.get(botRefKey(bot))
}

function clearFailure(bot: Pick<Bot, 'hostId' | 'id'>): void {
  const kept = failures.get(bot.hostId)
  if (kept?.delete(botRefKey(bot)) && kept.size === 0) {
    failures.delete(bot.hostId)
  }
}
// Per host, its bots as last looked at: a notice that left a host's list as it was (a Needs You count, a
// detail of the list) costs one compare for that host. Per bot, its record as last looked at, by its save
// time, picture fields and links: a list rebuilt around a deleted bot asks nothing about the bots it only
// moved.
const seenHosts = new Map<ExecutionHostId, readonly Bot[]>()
const seen = new Map<string, string>()

// A bot record by its save time, picture fields and links: plain fields, so a list rebuilt around a deleted
// bot costs one string per moved bot, with no look worked out.
function recordSeen(bot: Bot): string {
  return [
    bot.updatedAt,
    bot.avatar,
    bot.avatarColor,
    bot.avatarOutfit,
    Boolean(bot.slack || bot.github)
  ].join('|')
}

// Ends an attempt that can't go on; a `failed` one waits for a real step.
function forget(bot: Bot, attempt: number, failed = false, off = false): void {
  const key = botRefKey(bot)
  const entry = handled.get(key)
  if (entry?.attempt !== attempt) {
    return
  }
  handled.delete(key)
  if (failed) {
    const kept = failures.get(bot.hostId) ?? new Map<string, Failure>()
    kept.set(key, { look: entry.look, bot, off })
    failures.set(bot.hostId, kept)
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
  // Bots off, or the host away: not a failure. Turning bots on, or the host's return, asks again.
  if (!stillCurrent(bot, attempt)) {
    forget(bot, attempt)
    return
  }
  try {
    const parsed = parseBotAvatar(bot.avatar)
    const want = parsed?.kind === 'mascot' ? await botSlackIconWanted(bot, look) : null
    if (!want?.current || parsed?.kind !== 'mascot') {
      // The host hasn't saved this look yet (its saved record asks again), or its own bots are off (this
      // window can't see that switch): either way the next real step, such as focusing the window, asks.
      forget(bot, attempt, want?.current === false, true)
      return
    }
    if (!want.wanted) {
      clearFailure(bot)
      return
    }
    const png = stillCurrent(bot, attempt)
      ? await drawBotSlackIcon(parsed.id, bot.avatarColor ?? null, wornBotOutfit(bot.avatarOutfit))
      : undefined
    if (png === undefined || !stillCurrent(bot, attempt)) {
      forget(bot, attempt)
      return
    }
    if (png && (await uploadBotSlackIcon(bot, look, png))) {
      clearFailure(bot)
      return
    }
    // No drawing, or the host's look changed meanwhile: only a drawing that failed waits for a real step.
    forget(bot, attempt, !png)
  } catch (error) {
    forget(bot, attempt, true)
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
    handled.get(key)?.look === look ||
    // Failed at this look: it waits for a real step, which clears this first.
    failureOf(bot)?.look === look ||
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

// A real step for this bot: what this window knew of its icon is dropped, and its host is asked again.
function askAgain(bot: Bot): void {
  allowOutfitReadsAgain()
  handled.delete(botRefKey(bot))
  clearFailure(bot)
  publishBotSlackIcon(bot)
}

/** `save`, then the saved bot's icon published, for a window's own picture edits. */
export function withSlackIconPublish<T>(
  save: (updates: T) => Promise<Bot | null>,
  hostId: Bot['hostId']
): (updates: T) => Promise<Bot | null> {
  return async (updates) => {
    const saved = await save(updates)
    if (saved) {
      const bot = { ...saved, hostId }
      // Its list notice for this same save then asks nothing more.
      seen.set(botRefKey(bot), recordSeen(bot))
      askAgain(bot)
    }
    return saved
  }
}

// A host's bots that left its list (deleted, or the host unpaired) keep nothing here: only that host's
// previous list is looked at, never other hosts' bots.
function prune(hostId: ExecutionHostId, before: readonly Bot[], bots: readonly Bot[]): void {
  const listed = new Set(bots.map(botRefKey))
  for (const bot of before) {
    const key = botRefKey(bot)
    if (!listed.has(key)) {
      handled.delete(key)
      clearFailure(bot)
      seen.delete(key)
      pending.get(hostId)?.delete(key)
    }
  }
}

// Each host whose list changed is looked at; in it, each bot record not looked at before. `all` asks about
// every bot again (bots just turned on).
function publishLooks(all = false): void {
  if (!readBotsEnabled()) {
    return
  }
  const hostIds = readBotHostIds()
  for (const hostId of hostIds) {
    const bots = readHostBots(hostId)
    if (!all && seenHosts.get(hostId) === bots) {
      continue
    }
    prune(hostId, seenHosts.get(hostId) ?? [], bots)
    seenHosts.set(hostId, bots)
    for (const bot of bots) {
      const record = recordSeen(bot)
      const key = botRefKey(bot)
      if (all || seen.get(key) !== record) {
        seen.set(key, record)
        askAgain(bot)
      }
    }
  }
  if (seenHosts.size > hostIds.length) {
    for (const [hostId, before] of seenHosts) {
      if (!hostIds.includes(hostId)) {
        seenHosts.delete(hostId)
        prune(hostId, before, [])
      }
    }
  }
}

// Back from offline, or its event stream back after a gap: another client may have replaced its icons.
function hostCameBack(hostId: ExecutionHostId): void {
  if (readBotsEnabled()) {
    readHostBots(hostId).forEach(askAgain)
  }
}

// Each failed icon is tried again, from its record as it failed (a newer record already cleared it).
function retry(kept: ReadonlyMap<string, Failure>, onlyOff = false): void {
  for (const { bot, off } of kept.values()) {
    if (off || !onlyOff) {
      askAgain(bot)
    }
  }
}

// Coming back to the window is a real step for every host's failed icons.
function retryAll(): void {
  for (const kept of failures.values()) {
    retry(kept)
  }
}

// A host's settings changing (its own bots turned on) retries that host's icons it called not current.
// Read straight off the notice, so a host with none, or a notice of another kind, costs one lookup.
function hostSettingsChanged(event: Event): void {
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined
  if (!detail || typeof detail !== 'object' || !('hostId' in detail)) {
    return
  }
  const hostId = typeof detail.hostId === 'string' ? normalizeExecutionHostId(detail.hostId) : null
  const kept = hostId ? failures.get(hostId) : undefined
  const scope =
    'scope' in detail && detail.scope && typeof detail.scope === 'object' ? detail.scope : null
  const kinds = scope && 'kinds' in scope ? scope.kinds : undefined
  if (kept && (!Array.isArray(kinds) || kinds.includes('settings'))) {
    retry(kept, true)
  }
}

/** For the window: follows the bots list another surface loaded, and never loads it itself. */
export function useBotSlackIcons(): void {
  const enabled = useBotsEnabled()
  useEffect(() => {
    if (!enabled) {
      return
    }
    // Another client may have replaced icons while bots were off here: every look is asked about again.
    publishLooks(true)
    const run = (): void => publishLooks()
    const stopBots = subscribeToBotChanges(run)
    const stopCameBack = onBotHostCameBack(hostCameBack)
    window.addEventListener('focus', retryAll)
    window.addEventListener(BOTS_CHANGED_EVENT, hostSettingsChanged)
    return () => {
      stopBots()
      stopCameBack()
      window.removeEventListener('focus', retryAll)
      window.removeEventListener(BOTS_CHANGED_EVENT, hostSettingsChanged)
      // Off, nothing here is kept: no lists, no waiting attempts, and the one running stops at its next check.
      seenHosts.clear()
      seen.clear()
      handled.clear()
      failures.clear()
      pending.clear()
    }
  }, [enabled])
}
