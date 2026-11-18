// A bot's Composio apps as its cards, Add connector and Tools read them: the key's state and the bot's
// sign-ins, read once per bot however many show them, and again on the host's bots-changed notice.
import { useEffect, useSyncExternalStore } from 'react'
import { openBotHomeTab } from '@/lib/bot-catalog'
import { openBotSettings } from '../bot-settings-open'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import { botHostTarget, botRefKey, callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { useAppStore } from '@/store'
import { botToolErrorMessage } from '../bot-tools-client'
import { retryBotToolCheck } from '../bot-tools-revision'
import type { Bot } from '../../../../../shared/bot-types'
import type {
  ComposioApp,
  ComposioAppPage,
  ComposioConnections,
  ComposioStatus
} from '../../../../../shared/composio/composio-apps'
import type { ComposioSetupApp } from '../../../../../shared/composio/composio-setup-card'
import type { COMPOSIO_SETUP_STARTED_FROM } from '../../../../../shared/rpc-contract/bots-composio-params'

export type ComposioBotView = {
  status: ComposioStatus | null
  /**
   * Null until first read and while no key is saved. A refused key or a failed read keeps the last
   * sign-ins read, so the bot's apps stay listed while the owner fixes it.
   */
  connections: ComposioConnections | null
  /** Composio's own words when the sign-ins couldn't be read. */
  error: string | null
}

const EMPTY: ComposioBotView = { status: null, connections: null, error: null }

type Entry = { bot: BotRef; view: ComposioBotView; readers: number; reading: number }
// By botRefKey.
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
let attached = 0
let stopListening: (() => void) | null = null

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

async function read(ref: BotRef): Promise<void> {
  const key = botRefKey(ref)
  const entry = entries.get(key)
  if (!entry) {
    return
  }
  const { bot } = entry
  const ticket = (entry.reading += 1)
  const status = await callBotRpc<ComposioStatus>(bot, 'bots.composio.status', {
    botId: bot.id
  }).catch(() => null)
  const known = entry.view.connections
  let connections: ComposioConnections | null = status?.key === 'none' ? null : known
  let error: string | null = null
  if (status?.key === 'ok') {
    connections = await callBotRpc<ComposioConnections>(bot, 'bots.composio.connections', {
      botId: bot.id
    }).catch((failure: unknown) => {
      error = botToolErrorMessage(failure)
      return known
    })
  }
  // A later read started while this one was out; it wins.
  if (entries.get(key) !== entry || entry.reading !== ticket) {
    return
  }
  entry.view = { status, connections, error }
  emit()
}

/** Re-reads the shown bots of one host, or of every host. */
function rereadAll(hostId?: ExecutionHostId): void {
  for (const entry of entries.values()) {
    if (entry.readers > 0 && (hostId === undefined || entry.bot.hostId === hostId)) {
      void read(entry.bot)
    }
  }
}

function attach(bot: BotRef): () => void {
  const key = botRefKey(bot)
  let entry = entries.get(key)
  if (!entry) {
    entry = { bot: { hostId: bot.hostId, id: bot.id }, view: EMPTY, readers: 0, reading: 0 }
    entries.set(key, entry)
  }
  entry.readers += 1
  if (entry.readers === 1) {
    void read(bot)
  }
  if (attached === 0) {
    stopListening = onBotsChanged(rereadAll, undefined, { kinds: ['settings', 'bot'] })
  }
  attached += 1
  return () => {
    const current = entries.get(key)
    if (current) {
      current.readers -= 1
    }
    attached -= 1
    if (attached === 0) {
      stopListening?.()
      stopListening = null
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Null reads nothing, for a surface that shows a bot only sometimes. */
export function useComposioBot(bot: BotRef | null): ComposioBotView {
  const hostId = bot?.hostId ?? null
  const botId = bot?.id ?? null
  const key = bot ? botRefKey(bot) : null
  useEffect(() => (hostId && botId ? attach({ hostId, id: botId }) : undefined), [hostId, botId])
  return useSyncExternalStore(subscribe, () => (key ? entries.get(key)?.view : null) ?? EMPTY)
}

/** Reads one bot's Composio again, for a row's Check again. */
export function rereadComposioBot(bot: BotRef): void {
  void read(bot)
}

/** Reads the bot again, for a change made from this window. */
function changed(bot: BotRef): void {
  void read(bot)
  retryBotToolCheck()
}

/** Checks the key with Composio and saves it on the host; a card's dialog names its bot and app. */
export async function saveComposioKey(
  key: string,
  where: { hostId: ExecutionHostId; botId?: string; app?: ComposioSetupApp }
): Promise<void> {
  const { hostId, ...from } = where
  await callRuntimeRpc(botHostTarget(hostId), 'bots.composio.setKey', { key, ...from })
  if (from.botId) {
    changed({ hostId, id: from.botId })
  } else {
    rereadAll(hostId)
  }
}

export function declineComposioKey(bot: BotRef): Promise<unknown> {
  return callBotRpc(bot, 'bots.composio.declineKey', { botId: bot.id })
}

/** Opens the app's sign-in at Composio in the default browser, where the owner's accounts are. */
export async function connectComposioApp(
  bot: BotRef,
  app: string,
  /** A setup card's Connect, with the app's name for the chat's lines. */
  card?: { name: string; reason?: 'expired' }
): Promise<void> {
  const { url } = await callBotRpc<{ url: string }>(bot, 'bots.composio.connect', {
    botId: bot.id,
    app,
    ...(card ? { card } : {})
  })
  changed(bot)
  openComposioPage(url)
}

/** Composio's sign-in and API key pages open in the default browser, where the owner's accounts are. */
export function openComposioPage(url: string): void {
  void window.api.shell.openUrl(url)
}

/** One app as the host sees it now, for a card's Check again. */
export function readComposioApp(bot: BotRef, app: string): Promise<ComposioApp> {
  return callBotRpc(bot, 'bots.composio.app', { botId: bot.id, app })
}

export async function cancelComposioConnect(bot: BotRef, app: string): Promise<void> {
  await callBotRpc(bot, 'bots.composio.cancelConnect', { botId: bot.id, app })
  changed(bot)
}

export async function disconnectComposioApp(bot: BotRef, accountId: string): Promise<void> {
  await callBotRpc(bot, 'bots.composio.disconnect', { botId: bot.id, accountId })
  changed(bot)
}

/** Forgets the owner's key and takes Composio off every bot; the sign-ins stay at Composio. */
export async function removeComposioKey(
  hostId: ExecutionHostId,
  options: { alsoEvents?: boolean } = {}
): Promise<void> {
  await callRuntimeRpc(botHostTarget(hostId), 'bots.composio.removeKey', options)
  rereadAll(hostId)
  retryBotToolCheck()
}

/** Gives the bot its Composio tool, for an app with nothing to sign in to. */
export async function addComposioTool(bot: BotRef): Promise<void> {
  await callBotRpc(bot, 'bots.composio.add', { botId: bot.id })
  changed(bot)
}

/** One call past Composio's limit, as the owner checks whether it lifted; the host says if it did. */
export async function checkComposioLimit(bot: BotRef): Promise<void> {
  await callBotRpc(bot, 'bots.composio.checkLimit', null).catch(() => undefined)
  rereadAll(bot.hostId)
}

export function readComposioApps(
  bot: BotRef,
  options: { search?: string; cursor?: string }
): Promise<ComposioAppPage> {
  return callBotRpc(bot, 'bots.composio.apps', { botId: bot.id, ...options })
}

/** Opens the bot's chat and starts Composio setup there, with no message in the owner's name. */
export async function startComposioSetupInChat(
  bot: Bot,
  from: (typeof COMPOSIO_SETUP_STARTED_FROM)[number],
  app?: ComposioSetupApp
): Promise<void> {
  await callBotRpc(bot, 'bots.composio.startSetup', {
    botId: bot.id,
    from,
    ...(app ? { app } : {})
  })
  const { activeView, closeSettingsPage } = useAppStore.getState()
  if (activeView === 'settings') {
    closeSettingsPage()
  }
  await openBotHomeTab(bot)
}

export type ComposioEventsStatus = {
  target: 'none' | 'ours' | 'other'
  on: boolean
  /** The project's events hook, the by-hand steps' address; unsigned until a setup ends. */
  ingress?: { hookId: string; signed: boolean }
}

export function readComposioEvents(
  bot: BotRef,
  hookId: string,
  trigger: string
): Promise<ComposioEventsStatus> {
  return callBotRpc(bot, 'bots.composio.eventsStatus', { botId: bot.id, hookId, trigger })
}

/**
 * The events card's one click, or the by-hand steps' Done with the events hook they showed;
 * `replace` is the owner's yes to taking the project's events over.
 */
export async function setUpComposioEvents(
  bot: BotRef,
  hookId: string,
  trigger: { slug: string; config?: string },
  how: 'new' | 'replace' | { byHand: string }
): Promise<ComposioEventsStatus> {
  await callBotRpc(bot, 'bots.composio.setUpEvents', {
    botId: bot.id,
    hookId,
    trigger: trigger.slug,
    ...(trigger.config ? { config: trigger.config } : {}),
    ...(how === 'replace' ? { replace: true } : {}),
    ...(typeof how === 'object' ? { byHand: how.byHand } : {})
  })
  return readComposioEvents(bot, hookId, trigger.slug)
}

/** "I'll do it in Composio": makes the project's events hook, which the by-hand steps copy. */
export function composioEventsByHand(bot: BotRef, hookId: string): Promise<unknown> {
  return callBotRpc(bot, 'bots.composio.eventsByHand', { botId: bot.id, hookId })
}

/** For tests: forget every read. */
export function resetComposioClientForTest(): void {
  entries.clear()
  attached = 0
  stopListening?.()
  stopListening = null
}

// A bot whose Tools catalog should open with its search focused, set by "Browse Composio's apps".
let browseRequested: string | null = null

/** True once for the bot "Browse Composio's apps" asked to open. */
export function takeComposioBrowseRequest(botId: string): boolean {
  if (browseRequested !== botId) {
    return false
  }
  browseRequested = null
  return true
}

/** The bot's settings at Tools, where its Composio apps are; `browse` opens the catalog's search. */
export function openBotToolsSettings(botId: string, options: { browse?: boolean } = {}): void {
  browseRequested = options.browse ? botId : null
  openBotSettings(botId, 'tools')
}
