// A bot's tools, read and changed on the host that runs it.
import { useEffect, useSyncExternalStore } from 'react'
import { callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { botErrorMessage, botFailureMessage } from './bot-presentation'
import { changed, subscribe } from './bot-tools-revision'
import type {
  BotOwnTool,
  BotTools,
  BotToolInput,
  BotToolDetails,
  BotToolContext
} from '../../../../shared/bot-tools'
import type {
  BotToolSignInFailure,
  BotToolSignInProgress
} from '../../../../shared/bot-tool-sign-in'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { openBotHostPageOrSay } from '@/lib/bot-host-page'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import {
  begin,
  botToolSignInFailure,
  botToolSignInOutcome,
  connecting,
  failures,
  hostAttempts,
  outcomes,
  resetBotToolSignInState,
  started,
  startedKey
} from './bot-tool-sign-in-state'
import {
  BotToolPasteRefused,
  botToolHostName,
  finishOnHost,
  holdHostSignIn,
  resetBotToolHostName,
  signInOnHost
} from './bot-tool-host-sign-in'

export {
  botToolSignInFailure,
  botToolSignInOutcome,
  openBotToolSignInPage
} from './bot-tool-sign-in-state'
export { botToolHostName, signInOnHost, useBotToolHostSignIn } from './bot-tool-host-sign-in'

/** The host's own words for a refused tool change (a taken name, a wrong address), or this window's for a refused paste, else the generic line. */
export function botToolErrorMessage(error: unknown): string {
  if (error instanceof BotToolPasteRefused) {
    return error.message
  }
  const coded = botFailureMessage(error)
  if (coded) {
    return coded
  }
  return error instanceof RuntimeRpcCallError && error.code === 'runtime_error' && error.message
    ? error.message
    : botErrorMessage(error)
}

export async function addBotTool(bot: BotRef, source: string, name?: string): Promise<BotOwnTool> {
  const { tool } = await callBotRpc<{ tool: BotOwnTool }>(bot, 'bots.tools.add', {
    botId: bot.id,
    source,
    ...(name ? { name } : {})
  })
  changed()
  return tool
}

export function readBotToolContext(bot: BotRef): Promise<BotToolContext> {
  return callBotRpc(bot, 'bots.tools.context', { botId: bot.id })
}
export function readBotToolDetails(bot: BotRef, name: string): Promise<BotToolDetails> {
  return callBotRpc(bot, 'bots.tools.details', { botId: bot.id, name })
}
export async function saveBotTool(
  bot: BotRef,
  config: BotToolInput,
  edit?: { name: string; version: string }
): Promise<BotOwnTool> {
  const { tool } = await callBotRpc<{ tool: BotOwnTool }>(
    bot,
    edit ? 'bots.tools.update' : 'bots.tools.add',
    { botId: bot.id, config, ...edit }
  )
  changed()
  return tool
}

export async function removeBotTool(bot: BotRef, name: string): Promise<void> {
  await callBotRpc(bot, 'bots.tools.remove', { botId: bot.id, name })
  changed()
}

type ConnectAnswer =
  /** The tool's agent CLI signs in: the page to open, or null when the CLI opened it. */
  | { authorizationUrl: string | null }
  /** Orca signs in: the host opened the browser itself. */
  | { attemptId: string; authorizationOrigin: string }

/** Opens the tool's sign-in page, and returns it when it can be opened again (null: it can't, or
 *  nothing to sign in to); the host finishes once the browser comes back. `owned`: Orca signs in
 *  to the tool (it has `signIn`), not its agent's CLI. */
export async function connectBotTool(
  bot: BotRef,
  name: string,
  owned = false
): Promise<string | null> {
  const key = startedKey(bot, name)
  begin(key)
  // The web client has no Orca browser and signs in by pasting; a desktop opens a server bot's
  // page in that server's own session, so the app returns to the server's listener.
  if (owned && isPairedWebClientWindow()) {
    return signInOnHost(bot, name, 'paste')
  }
  if (owned && bot.hostId !== LOCAL_EXECUTION_HOST_ID) {
    return signInOnHost(bot, name, 'routed')
  }
  const answer = await callBotRpc<ConnectAnswer>(bot, 'bots.tools.connect', {
    botId: bot.id,
    name
  })
    .catch(async (error: unknown) => {
      // A Connect Orca refused (the app isn't supported, can't be reached) leaves its reason there.
      const { progress } = await readSignInStatus(bot, name)
      if (progress?.state === 'failed') {
        started.delete(key)
        outcomes.set(key, 'failed')
        failures.set(key, progress.code)
      }
      throw error
    })
    .finally(() => connecting.delete(key))
  if (!('authorizationUrl' in answer)) {
    return null
  }
  if (answer.authorizationUrl) {
    openBotHostPageOrSay(bot.hostId, answer.authorizationUrl, { bot, local: 'system' })
  }
  return answer.authorizationUrl
}

/** Finishes a sign-in whose browser ran on another computer, from the address it ended on. */
export async function finishBotToolSignIn(
  bot: BotRef,
  name: string,
  address: string
): Promise<void> {
  const key = startedKey(bot, name)
  if (hostAttempts.has(key)) {
    await finishOnHost(key, address)
    return
  }
  await callBotRpc(bot, 'bots.tools.finishSignIn', { botId: bot.id, name, address })
}

const SIGN_IN_POLL_MS = 2_000
const SIGN_IN_WATCH_MS = 600_000

type SignInStatus = { status: string; progress?: BotToolSignInProgress }

function readSignInStatus(bot: BotRef, name: string): Promise<SignInStatus> {
  return callBotRpc<SignInStatus>(bot, 'bots.tools.signInStatus', {
    botId: bot.id,
    name
  }).catch(() => ({ status: 'pending' }))
}

type Watch = { users: number; timer: ReturnType<typeof setTimeout> | null }
const watches = new Map<string, Watch>()

// One loop per sign-in, however many rows and cards show it, asking the host how it went (read from
// memory there, so no server starts); it stops when the sign-in ends or the last of them goes away.
function watchSignIn(bot: BotRef, name: string): () => void {
  const key = startedKey(bot, name)
  const shared = watches.get(key)
  const watch = shared ?? { users: 0, timer: null }
  watch.users += 1
  if (!shared) {
    watches.set(key, watch)
    const deadline = Date.now() + SIGN_IN_WATCH_MS
    const tick = async (): Promise<void> => {
      const { status, progress } = await readSignInStatus(bot, name)
      if (watches.get(key) !== watch) {
        return
      }
      if ((status === 'pending' || connecting.has(key)) && Date.now() < deadline) {
        watch.timer = setTimeout(() => void tick(), SIGN_IN_POLL_MS)
        return
      }
      watches.delete(key)
      started.delete(key)
      outcomes.set(key, status)
      if (progress?.state === 'failed') {
        failures.set(key, progress.code)
      }
      changed()
    }
    watch.timer = setTimeout(() => void tick(), SIGN_IN_POLL_MS)
  }
  return () => {
    watch.users -= 1
    if (watch.users === 0 && watches.get(key) === watch) {
      if (watch.timer) {
        clearTimeout(watch.timer)
      }
      watches.delete(key)
    }
  }
}

export type BotToolSignInView = {
  /** This window started the tool's sign-in, and it hasn't ended. */
  active: boolean
  /** How the last one from this window ended; undefined while it runs or if none did. */
  outcome: string | undefined
  /** Why Orca's own last sign-in failed; undefined if it didn't. */
  failure: BotToolSignInFailure | 'needs-update' | undefined
  /** The computer the bot runs on, for "Update Orca on …". */
  hostName: string | null
}

/** The tool's sign-in from this window, read as snapshots so every change re-renders; while it runs, waits for it to end. */
export function useBotToolSignIn(bot: BotRef, name: string): BotToolSignInView {
  const key = startedKey(bot, name)
  const active = useSyncExternalStore(subscribe, () => started.has(key))
  const outcome = useSyncExternalStore(subscribe, () => botToolSignInOutcome(bot, name))
  const failure = useSyncExternalStore(subscribe, () => botToolSignInFailure(bot, name))
  const hostName = useSyncExternalStore(subscribe, () => botToolHostName(bot.hostId))
  // The host's own sign-in is followed from where it started, not by these rows.
  const hosted = useSyncExternalStore(subscribe, () => hostAttempts.has(key))
  const { hostId, id } = bot
  useEffect(
    () => (active && !hosted ? watchSignIn({ hostId, id }, name) : undefined),
    [active, hosted, hostId, id, name]
  )
  useEffect(() => (active ? holdHostSignIn(key) : undefined), [active, key])
  return { active, outcome, failure, hostName }
}

/** The bot's own tools as the host has them now, past any cached read. */
export async function readBotOwnTools(bot: BotRef): Promise<readonly BotOwnTool[]> {
  const tools = await callBotRpc<BotTools>(bot, 'bots.tools.list', { botId: bot.id })
  return 'own' in tools ? tools.own : []
}

/** Forgets every sign-in this window started, for fixtures that share one page. */
export function resetBotToolSignInsForTest(): void {
  for (const watch of watches.values()) {
    if (watch.timer) {
      clearTimeout(watch.timer)
    }
  }
  watches.clear()
  resetBotToolSignInState()
  resetBotToolHostName()
}
