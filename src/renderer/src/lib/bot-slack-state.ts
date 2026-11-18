// Each bot's Slack app as Orca Cloud reports it, read on demand and shared by every Slack surface.
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  BOT_SLACK_DESKTOP_ERRORS,
  type ConnectorBotSlackState,
  type ConnectorBotSlackStateResponse
} from '../../../shared/connector-bot-slack-contract'
import { hostConnectorAccount } from './signed-in-orca-account'
import { followProviderReturn } from './browser-return-watch'
import { botSlackCalls } from './bot-connector-host-calls'
import { botRefKey, type BotRef } from './bot-hosts'

export type BotSlackView =
  | { status: 'loading' }
  | { status: 'ready'; slack: ConnectorBotSlackStateResponse }
  | { status: 'failed'; error: string }

/** The bot's Slack in one workspace; with no team, its first. An older cloud lists no teams. */
export function slackTeamState(
  slack: ConnectorBotSlackStateResponse,
  teamId: string | undefined
): ConnectorBotSlackState {
  if (teamId === undefined) {
    return slack
  }
  const listed = slack.teams?.find((team) => 'teamId' in team && team.teamId === teamId)
  return (
    listed ??
    ('teamId' in slack && slack.teamId === teamId ? slack : { state: 'not_created' as const })
  )
}

// An install begun and not done yet. An update needed is followed only once the owner starts it.
// An app waiting for its install, or an installed one whose identity change waits on approval.
const awaitsInstall = (slack: ConnectorBotSlackState): boolean =>
  slack.state === 'created' || (slack.state === 'installed' && slack.postAsPending !== undefined)

const LOADING: BotSlackView = { status: 'loading' }
// How often a shown bot whose app waits for its install asks whether Slack finished it, and for how
// long; after that, and for every other shown bot, a return to Orca's window reads again at most
// every ON_FOCUS_MS.
const INSTALL_POLL_MS = 3_000
const INSTALL_POLL_FOR_MS = 10 * 60_000
const ON_FOCUS_MS = 60_000

const views = new Map<string, BotSlackView>()
const latestRequest = new Map<string, number>()
const lastAsked = new Map<string, number>()
const listeners = new Set<() => void>()

export function readBotSlack(bot: BotRef): BotSlackView {
  return views.get(botRefKey(bot)) ?? LOADING
}

// Per bot, the newest ask still out and the account it asked as; a surface that mounts meanwhile
// under that account takes its answer instead of asking again.
const inFlight = new Map<string, { asked: Promise<BotSlackView>; account: string | null }>()

/**
 * Asks the cloud again; an answer to an older ask never replaces a newer one. `background` (a
 * re-read nobody clicked for): a failure keeps the last answer read as the same account, so a
 * slow or refused re-read never flickers what the bot needs.
 */
export function refreshBotSlack(bot: BotRef, background = false): Promise<BotSlackView> {
  const key = botRefKey(bot)
  lastAsked.set(key, Date.now())
  const account = hostConnectorAccount(bot.hostId)
  const asked = askBotSlack(bot, account, background)
  const current = { asked, account }
  inFlight.set(key, current)
  void asked.finally(() => {
    if (inFlight.get(key) === current) {
      inFlight.delete(key)
    }
  })
  return asked
}

function readOnShow(bot: BotRef): Promise<BotSlackView> {
  const current = inFlight.get(botRefKey(bot))
  return current?.account === hostConnectorAccount(bot.hostId)
    ? current.asked
    : refreshBotSlack(bot, true)
}

// The account each bot's shown answer was read as.
const readAs = new Map<string, string | null>()

async function askBotSlack(
  bot: BotRef,
  account: string | null,
  background: boolean
): Promise<BotSlackView> {
  const key = botRefKey(bot)
  const request = (latestRequest.get(key) ?? 0) + 1
  latestRequest.set(key, request)
  const view = await botSlackCalls(bot.hostId)
    .state({ botId: bot.id })
    .then(
      (result): BotSlackView =>
        result.ok
          ? { status: 'ready', slack: result.value }
          : { status: 'failed', error: result.error },
      (): BotSlackView => ({ status: 'failed', error: BOT_SLACK_DESKTOP_ERRORS.failed })
    )
  const kept =
    background &&
    view.status === 'failed' &&
    view.error !== BOT_SLACK_DESKTOP_ERRORS.signedOut &&
    views.get(key)?.status === 'ready' &&
    readAs.get(key) === account
  if (latestRequest.get(key) === request && !kept) {
    views.set(key, view)
    readAs.set(key, account)
    listeners.forEach((listener) => listener())
  }
  return readBotSlack(bot)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// One sequential poll per bot however many surfaces follow it, so slow answers are never all superseded.
const polls = new Map<string, { followers: number }>()

/** `returnUrl`: where Slack's page sends the browser back, so a landing there or focus reads at once. */
function follow(bot: BotRef, returnUrl: string | null): () => void {
  const key = botRefKey(bot)
  let poll = polls.get(key)
  if (!poll) {
    const started = { followers: 0 }
    polls.set(key, started)
    const until = Date.now() + INSTALL_POLL_FOR_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    let reading = false
    const check = (): void => {
      // A poll stopped and restarted meanwhile is a new one; this one ends.
      if (polls.get(key) !== started) {
        returns.stop()
        return
      }
      // Ended, so a later wait (a surface shown, Set up clicked again) starts a fresh one.
      if (Date.now() >= until) {
        polls.delete(key)
        returns.stop()
        return
      }
      if (reading) {
        return
      }
      clearTimeout(timer)
      reading = true
      void refreshBotSlack(bot, true).then(() => {
        reading = false
        timer = setTimeout(check, returns.delay(INSTALL_POLL_MS))
      })
    }
    const returns = followProviderReturn({ returnUrl, check })
    timer = setTimeout(check, returns.delay(INSTALL_POLL_MS))
    poll = started
  }
  poll.followers += 1
  const followed = poll
  return () => {
    followed.followers -= 1
    if (followed.followers === 0 && polls.get(key) === followed) {
      polls.delete(key)
    }
  }
}

/** Slack's OAuth page returns the browser to the connector URL its authorize link names. */
export function slackReturnUrl(authorizeUrl: string): string | null {
  try {
    return new URL(authorizeUrl).searchParams.get('redirect_uri')
  } catch {
    return null
  }
}

function readOnFocus(bot: BotRef): void {
  if (Date.now() - (lastAsked.get(botRefKey(bot)) ?? 0) >= ON_FOCUS_MS) {
    void refreshBotSlack(bot, true)
  }
}

// The bot's ref, kept while its host and id stay the same, so effects follow the bot, not each re-read.
function useStableBotRefOrNull(bot: BotRef | null): BotRef | null {
  const hostId = bot?.hostId
  const id = bot?.id
  return useMemo(() => (hostId && id ? { hostId, id } : null), [hostId, id])
}

/**
 * The bot's Slack state, read fresh when shown and on returns to Orca, and followed for a while
 * when its app waits for an install, or while the caller waits on one it started (a first install
 * or an update's reinstall), through failed reads too.
 */
export function useBotSlack(
  bot: BotRef | null,
  awaitInstall = false,
  returnUrl: string | null = null
): BotSlackView {
  const ref = useStableBotRefOrNull(bot)
  const view = useSyncExternalStore(subscribe, () => (ref ? readBotSlack(ref) : LOADING))
  const following =
    awaitInstall ||
    (view.status === 'ready' && [view.slack, ...(view.slack.teams ?? [])].some(awaitsInstall))
  useEffect(() => {
    if (!ref) {
      return
    }
    void readOnShow(ref)
    const onFocus = (): void => readOnFocus(ref)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [ref])
  useEffect(
    () => (ref && following ? follow(ref, returnUrl) : undefined),
    [ref, following, returnUrl]
  )
  return view
}
