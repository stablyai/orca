// Orca's own sign-in to a bot's app run on the bot's host for this window (`bots.tools.signIn.*`):
// the page opens routed through the host, or on this device with its address pasted back.
import { useSyncExternalStore } from 'react'
import { callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { botHostUnroutedMessage, openOnServer } from '@/lib/bot-host-page'
import { readBotHostStatus } from '@/lib/bot-host-status'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  botToolSignInPastedQuery,
  type BotToolSignInAttemptView
} from '../../../../shared/bot-tool-sign-in'
import { BOTS_TOOLS_OWNED_SIGN_IN_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import { changed, subscribe } from './bot-tools-revision'
import {
  begin,
  connecting,
  end,
  hostAttempts,
  newestStart,
  openBotToolSignInPage,
  started,
  startedKey,
  type HostAttempt
} from './bot-tool-sign-in-state'

/** A paste this window refuses before sending it; its words are fixed and safe to show. */
export class BotToolPasteRefused extends Error {}
// A dropped connection retries the wait this often; the attempt lives on the host until it expires.
const HOST_RETRY_MS = 2_000

export type BotToolHostSignInView = {
  state: 'waiting' | 'finishing'
  paste: boolean
  /** The page, while it can be opened again. */
  url: string | null
}

/** How a host-run sign-in of the tool stands for this window; null when none is under way. */
export function useBotToolHostSignIn(bot: BotRef, name: string): BotToolHostSignInView | null {
  const attempt = useSyncExternalStore(subscribe, () => hostAttempts.get(startedKey(bot, name)))
  if (!attempt || (attempt.view.state !== 'waiting' && attempt.view.state !== 'finishing')) {
    return null
  }
  return {
    state: attempt.view.state,
    paste: attempt.paste,
    url: attempt.view.state === 'waiting' ? attempt.view.authorizationUrl : null
  }
}

/** The name of each bot host's computer as it last said it, for "Update Orca on …". */
const hostNames = new Map<ExecutionHostId, string>()
export function botToolHostName(hostId: ExecutionHostId): string | null {
  return hostNames.get(hostId) ?? null
}

async function hostSignsInForDevices(hostId: ExecutionHostId): Promise<boolean> {
  const status = await readBotHostStatus(hostId)
  if (status?.machineName) {
    hostNames.set(hostId, status.machineName)
  }
  return status?.capabilities?.includes(BOTS_TOOLS_OWNED_SIGN_IN_RUNTIME_CAPABILITY) === true
}

/**
 * Orca's own sign-in run on the bot's host for this window. `routed`: the page opens in the bot's
 * workspace browser, whose traffic goes through the host, so the app returns to the host's own
 * listener; when it can't open there, it signs in by paste instead. `paste`: the page opens in this
 * device's browser and the address it lands on is pasted back. Answers the page, to open again.
 */
export async function signInOnHost(
  bot: BotRef,
  name: string,
  mode: 'routed' | 'paste'
): Promise<string | null> {
  const key = startedKey(bot, name)
  if (!started.has(key)) {
    begin(key)
  }
  const start = newestStart.get(key)
  starting.add(key)
  try {
    if (!(await hostSignsInForDevices(bot.hostId))) {
      end(key, 'failed', 'needs-update')
      return null
    }
    const view = await callBotRpc<BotToolSignInAttemptView>(bot, 'bots.tools.signIn.start', {
      botId: bot.id,
      name,
      mode
    })
    if (newestStart.get(key) !== start) {
      // A newer start replaced it, or its surface closed before the host answered.
      cancelOnHost(bot, view)
      return null
    }
    if (view.state !== 'waiting') {
      end(key, 'failed', view.state === 'failed' ? view.code : undefined)
      return null
    }
    // A server's sign-in page opens only in its own session; this computer's browser has other logins.
    if (mode === 'routed' && !openOnServer(bot.hostId, view.authorizationUrl, bot)) {
      cancelOnHost(bot, view)
      toast.error(botHostUnroutedMessage(bot.hostId))
      end(key, 'failed', undefined)
      return null
    }
    hostAttempts.set(key, { bot, view, paste: mode === 'paste' })
    if (mode === 'paste') {
      openBotToolSignInPage(view.authorizationUrl)
    }
    changed()
    void followOnHost(key, name, view.flowId)
    return view.authorizationUrl
  } catch (error) {
    if (newestStart.get(key) === start && !hostAttempts.has(key)) {
      end(key, 'failed', undefined)
    }
    throw error
  } finally {
    starting.delete(key)
    connecting.delete(key)
  }
}

function cancelOnHost(bot: BotRef, view: BotToolSignInAttemptView): void {
  if (view.state === 'waiting') {
    void callBotRpc(bot, 'bots.tools.signIn.cancel', { flowId: view.flowId }).catch(() => {})
  }
}

// Host starts still waiting on the host's answer, by tool.
const starting = new Set<string>()
// The surfaces showing each tool's sign-in from this window (its row, the Add dialog, the chat card).
const holders = new Map<string, number>()

/**
 * Holds the tool's sign-in while a surface shows it; when the last lets go, a sign-in the host runs
 * for this window ends there too, so no page waits on a surface nobody can paste into. A surface
 * replacing another in the same commit takes it over first.
 */
export function holdHostSignIn(key: string): () => void {
  holders.set(key, (holders.get(key) ?? 0) + 1)
  return () => {
    const left = (holders.get(key) ?? 1) - 1
    if (left > 0) {
      holders.set(key, left)
      return
    }
    holders.delete(key)
    setTimeout(() => {
      if (!holders.has(key)) {
        leaveHostSignIn(key)
      }
    }, 0)
  }
}

function leaveHostSignIn(key: string): void {
  const attempt = hostAttempts.get(key)
  if (!attempt && !starting.has(key)) {
    // None, or one on this computer, which its own browser finishes.
    return
  }
  // A start still answering sees it was left, and cancels what it started.
  newestStart.delete(key)
  if (attempt) {
    cancelOnHost(attempt.bot, attempt.view)
  }
  started.delete(key)
  connecting.delete(key)
  hostAttempts.delete(key)
  changed()
}

/** The tool's attempt, while `flowId` is still the newest from this window. */
function current(key: string, flowId: string): HostAttempt | null {
  const attempt = hostAttempts.get(key)
  return attempt?.view.flowId === flowId ? attempt : null
}

/** Records the host's view of the attempt, unless a newer start replaced it; settles it when it ended. */
function take(key: string, view: BotToolSignInAttemptView): void {
  const attempt = current(key, view.flowId)
  if (!attempt) {
    return
  }
  if (view.state === 'done') {
    end(key, 'done', undefined)
  } else if (view.state === 'failed') {
    end(key, 'failed', view.code)
  } else if (view.state !== attempt.view.state || view.revision !== attempt.view.revision) {
    // A new record per change, so readers see it.
    hostAttempts.set(key, { ...attempt, view })
    changed()
  }
}

/** Follows the host's attempt until it settles; a dropped connection keeps it, until it expires. */
async function followOnHost(key: string, name: string, flowId: string): Promise<void> {
  for (let attempt = current(key, flowId); attempt; attempt = current(key, flowId)) {
    const { view } = attempt
    const next = await callBotRpc<BotToolSignInAttemptView>(
      attempt.bot,
      'bots.tools.signIn.wait',
      { botId: attempt.bot.id, name, flowId, afterRevision: view.revision },
      { timeoutMs: 60_000 }
    ).catch(() => null)
    if (next) {
      take(key, next)
    } else if (Date.now() > view.expiresAt) {
      take(key, { ...view, state: 'failed', code: 'expired' })
    } else {
      await new Promise((resolve) => setTimeout(resolve, HOST_RETRY_MS))
    }
  }
}

/** Finishes the tool's host attempt from the address pasted back; a wrong address spends nothing. */
export async function finishOnHost(key: string, address: string): Promise<void> {
  const held = hostAttempts.get(key)
  const view = held?.view
  if (!held || view?.state !== 'waiting') {
    return
  }
  const query = botToolSignInPastedQuery(address, view)
  if (query === null) {
    throw new BotToolPasteRefused(
      translate(
        'bots.tools.signIn.notThisSignIn',
        'That address isn’t from this sign-in. Paste the address you landed on.'
      )
    )
  }
  take(key, { ...view, state: 'finishing' })
  try {
    take(
      key,
      await callBotRpc<BotToolSignInAttemptView>(held.bot, 'bots.tools.signIn.finish', {
        flowId: view.flowId,
        query
      })
    )
  } catch (error) {
    // A refused paste spends nothing: the attempt waits for the right address.
    const attempt = current(key, view.flowId)
    if (attempt?.view.state === 'finishing') {
      hostAttempts.set(key, { ...attempt, view })
      changed()
    }
    throw error
  }
}

/** Forgets the host's name, for fixtures that share one page. */
export function resetBotToolHostName(): void {
  hostNames.clear()
  holders.clear()
  starting.clear()
}
