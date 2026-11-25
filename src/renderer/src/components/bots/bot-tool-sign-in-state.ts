// Sign-ins started from this window, by tool, as every surface showing them reads them: whether one
// runs, how the last ended, and the one the bot's host runs for this window.
import type {
  BotToolSignInAttemptView,
  BotToolSignInFailure
} from '../../../../shared/bot-tool-sign-in'
import { changed } from './bot-tools-revision'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'

// Sign-ins started from this window, kept past the row or card that started them for the paste-back.
export const started = new Set<string>()
// Connects still waiting on the host's answer: a status read now may predate this try.
export const connecting = new Set<string>()
export const startedKey = (bot: BotRef, name: string) => `${botRefKey(bot)}\0${name}`
// How each ended sign-in went, as the host last said: done, failed, or still pending past the watch.
export const outcomes = new Map<string, string>()
// Why a sign-in Orca ran itself failed, when the host said; `needs-update`: the host's Orca predates
// signing in for another device.
export const failures = new Map<string, BotToolSignInFailure | 'needs-update'>()

/** How the tool's last sign-in from this window ended; undefined while it runs or if none did. */
export function botToolSignInOutcome(bot: BotRef, name: string): string | undefined {
  return outcomes.get(startedKey(bot, name))
}

/** Why the last sign-in Orca ran for the tool from this window failed; undefined if it didn't. */
export function botToolSignInFailure(
  bot: BotRef,
  name: string
): BotToolSignInFailure | 'needs-update' | undefined {
  return outcomes.get(startedKey(bot, name)) === 'failed'
    ? failures.get(startedKey(bot, name))
    : undefined
}

// The newest start for each tool from this window; an older one answering later steps aside.
export const newestStart = new Map<string, symbol>()

/** A sign-in from this window starts: it replaces any this window had going for the tool. */
export function begin(key: string): void {
  newestStart.set(key, Symbol(key))
  started.add(key)
  outcomes.delete(key)
  failures.delete(key)
  hostAttempts.delete(key)
  connecting.add(key)
  changed()
}

// Sign-ins the bot's host runs for this window (`bots.tools.signIn.*`), by tool; the newest start
// replaces the entry, which ends the older one's follow.
export type HostAttempt = {
  /** The bot whose host runs the attempt. */
  bot: BotRef
  view: BotToolSignInAttemptView
  /** The page is open in this device's browser and its address comes back by paste. */
  paste: boolean
}
export const hostAttempts = new Map<string, HostAttempt>()

/** A sign-in from this window ended, as the host said. */
export function end(
  key: string,
  outcome: string,
  failure: BotToolSignInFailure | 'needs-update' | undefined
): void {
  started.delete(key)
  connecting.delete(key)
  hostAttempts.delete(key)
  outcomes.set(key, outcome)
  if (failure) {
    failures.set(key, failure)
  }
  changed()
}

/** A sign-in page, like the connectors' setup: the default browser, where the owner's accounts are. */
export function openBotToolSignInPage(url: string): void {
  void window.api.shell.openUrl(url)
}

/** Forgets every sign-in this window started. */
export function resetBotToolSignInState(): void {
  started.clear()
  connecting.clear()
  outcomes.clear()
  failures.clear()
  hostAttempts.clear()
  newestStart.clear()
}
