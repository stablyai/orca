// Every listed host's bots, read from its runtime; the catalog-change bridge refreshes the host that changed.
import { useContext, useMemo, useSyncExternalStore } from 'react'
import type { Bot } from '../../../shared/bot-types'
import type { BotMemoryHistoryView } from '../../../shared/bots/bot-memory-history'
import type { BotListWait } from '../../../shared/bots/bot-list-waits'
import {
  applyBotUpdates,
  type BotCreateParams,
  type BotDeleteParams,
  type BotSessionStartParams,
  type BotTakeOverParams,
  type BotUpdateParams
} from '../../../shared/rpc-contract/bots-params'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { activateAndRevealFolderWorkspace } from './workspace/activation/worktree-activation'
import {
  activateStructuredAgentSessionById,
  activateStructuredAgentSessionTabOnOwner
} from './agent-session/structured-agent-session-tab-activation'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { structuredAgentSessionTabId } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { appendNativeChatDraftCache } from '@/components/native-chat/drafts/native-chat-draft-views'
import {
  publishBots as publish,
  readBots,
  readBotThreadReplies,
  readBotItemsNeedingOwner,
  readBotWaits,
  readBotWebhooks,
  readBotHostConnectorStatus,
  readConnectorNeedsSignIn,
  type BotHostConnectorStatus,
  readHasBot,
  readBotHostIds,
  readHostBots,
  stampBotHost,
  subscribeToBotChanges
} from './bot-catalog-snapshot'
import { withKeptBotHomes } from './bot-host-kept-homes'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  beginBotHostUpdate,
  followBotHostNotices,
  refreshBotHost,
  refreshBots
} from './bot-host-refresh'
import { botHostTarget, botTarget, callBotRpc, ownBotHost, type BotRef } from './bot-hosts'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import {
  getRuntimeTargetHostId,
  runtimeTargetEnvironmentId
} from '@/runtime/rpc/targets/runtime-client-target'
import { NativeChatVisualOwnerContext } from '@/components/native-chat/media/visuals/native-chat-visual-owner'
import { isHome, type BotHomeOwner } from '../../../shared/bots/bot-homes'
import { requestNativeChatComposerFocus } from '../components/native-chat/composer/focus/native-chat-composer-focus-intent'
import { structuredAgentSessionDraftScopeKey } from '../components/native-chat/drafts/native-chat-draft-scope'

export { isHome, readBots, readHostBots, refreshBotHost, refreshBots, subscribeToBotChanges }

const NO_BOTS: readonly Bot[] = []

let loaded = false

function subscribe(listener: () => void): () => void {
  const unsubscribe = subscribeToBotChanges(listener)
  if (!loaded) {
    loaded = true
    // For the session: each host's change, or its coming back, re-reads only that host.
    followBotHostNotices()
    void refreshBots()
  }
  return unsubscribe
}

const subscribeToNothing = (): (() => void) => () => {}
const readNoBots = (): readonly Bot[] => NO_BOTS

/** Every listed host's bots; `enabled: false` reads nothing, for shared surfaces that only need bots on a bot's page. */
export function useBots(enabled = true): readonly Bot[] {
  const read = enabled ? readBots : readNoBots
  return useSyncExternalStore(enabled ? subscribe : subscribeToNothing, read, read)
}

/** The bots' and groups' homes: the store's, and each away server's kept homes. Other folder
 * workspaces' writes (activity, unread) keep this identity. */
export function useBotHomeWorkspaces(
  bots: readonly BotHomeOwner[],
  groups: readonly BotHomeOwner[]
): readonly FolderWorkspace[] {
  const selectHomes = useMemo(() => createBotHomesSelector([...bots, ...groups]), [bots, groups])
  const homes = useAppStore(useShallow(selectHomes))
  // The listed hosts change when a server is first listed from its kept read.
  const hostIds = useSyncExternalStore(subscribe, readBotHostIds, readBotHostIds)
  return useMemo(() => withKeptBotHomes(homes, hostIds), [homes, hostIds])
}

const NO_FOLDERS: readonly FolderWorkspace[] = []

/** The owners' homes among the store's folder workspaces, filtered again only when that list changes. */
function createBotHomesSelector(
  owners: readonly BotHomeOwner[]
): (state: AppState) => FolderWorkspace[] {
  let last: { folders: readonly FolderWorkspace[]; homes: FolderWorkspace[] } | null = null
  return (state) => {
    const folders = selectFolderWorkspaces(state) ?? NO_FOLDERS
    if (!last || last.folders !== folders) {
      last = { folders, homes: folders.filter((folder) => isHome(folder, owners)) }
    }
    return last.homes
  }
}

/** One host's bots, for what belongs to that computer, such as its own accounts in Settings › Bots. */
export function useHostBots(hostId: ExecutionHostId): readonly Bot[] {
  const read = (): readonly Bot[] => readHostBots(hostId)
  return useSyncExternalStore(subscribe, read, read)
}

const readNoBot = (): null => null

/**
 * The bot a chat card names by id alone: `bot` once listed (null before, or for none), and `ref`
 * to call its host. Ids are random per host, so it is the bot on the computer the chat runs on,
 * or this app's own outside a chat.
 */
export function useCardBot(botId: string): { bot: Bot | null; ref: BotRef } {
  const target = useContext(NativeChatVisualOwnerContext)?.target
  const hostId = target ? getRuntimeTargetHostId(target) : ownBotHost().hostId
  const bot = useBots().find((entry) => entry.id === botId && entry.hostId === hostId) ?? null
  const ref = useMemo(() => ({ hostId, id: botId }), [hostId, botId])
  return { bot, ref }
}

/** `readHasBot`, or null while `enabled` is false. */
export function useHasBot(enabled: boolean): boolean | null {
  return useSyncExternalStore(
    enabled ? subscribe : subscribeToNothing,
    enabled ? readHasBot : readNoBot,
    enabled ? readHasBot : readNoBot
  )
}

/** The bot's waits still waiting, from the last list read; none from an older host. */
export function useBotWaits(bot: BotRef): readonly BotListWait[] {
  const read = (): readonly BotListWait[] => readBotWaits(bot)
  return useSyncExternalStore(subscribe, read, read)
}

/** The bot's Needs you items that aren't stale, from its host's last list read or items notice; null
 *  until one lands, or with no bot. */
export function useListedBotItemsNeedingOwner(bot: BotRef | null): number | null {
  const read = (): number | null => (bot ? readBotItemsNeedingOwner(bot) : null)
  return useSyncExternalStore(subscribe, read, read)
}

/** Whether results can go to an event's thread: the host's Orca Cloud binds it; false for no host. */
export function useBotThreadReplies(hostId: ExecutionHostId | null): boolean {
  const read = (): boolean => (hostId ? readBotThreadReplies(hostId) : false)
  return useSyncExternalStore(subscribe, read, read)
}

/** Whether the host's Orca Cloud takes webhooks; undefined from an older host, which doesn't say, or for no host. */
export function useBotWebhooks(hostId: ExecutionHostId | null): boolean | undefined {
  const read = (): boolean | undefined => (hostId ? readBotWebhooks(hostId) : undefined)
  return useSyncExternalStore(subscribe, read, read)
}

/** Whether the host must sign in to Orca again before its bots hear anything; re-read on its bots change. */
export function useConnectorNeedsSignIn(hostId: ExecutionHostId): boolean {
  const read = (): boolean => readConnectorNeedsSignIn(hostId)
  return useSyncExternalStore(subscribe, read, read)
}

/** The host's link to Orca Cloud, from its last bots.list; undefined from an older host or without Orca Cloud. */
export function useBotHostConnectorStatus(
  hostId: ExecutionHostId
): BotHostConnectorStatus | undefined {
  const read = (): BotHostConnectorStatus | undefined => readBotHostConnectorStatus(hostId)
  return useSyncExternalStore(subscribe, read, read)
}

/** Settings › Bots › Enable bots, on unless turned off. Off hides every bot surface; the bots and their folders stay. */
export function useBotsEnabled(): boolean {
  return useAppStore((state) => state.settings?.botsEnabled !== false)
}

/** `useBotsEnabled` for code outside React. */
export function readBotsEnabled(): boolean {
  return useAppStore.getState().settings?.botsEnabled !== false
}

/** Makes the bot on `hostId`; it answers stamped with that host, so calls about it go there. */
export async function createBot(hostId: ExecutionHostId, params: BotCreateParams): Promise<Bot> {
  const { bot } = await callRuntimeRpc<{ bot: Bot }>(botHostTarget(hostId), 'bots.create', params)
  await refreshBotHost(hostId)
  return stampBotHost(hostId, bot)
}

/** Shown at once, so a second change made before the first lands builds on it. */
export async function updateBot(target: BotRef, updates: BotUpdateParams['updates']): Promise<Bot> {
  const { hostId } = target
  publish(
    readHostBots(hostId).map((entry) =>
      entry.id === target.id ? applyBotUpdates(entry, updates) : entry
    ),
    undefined,
    hostId
  )
  const endUpdate = beginBotHostUpdate(hostId)
  try {
    const { bot } = await callBotRpc<{ bot: Bot }>(target, 'bots.update', {
      botId: target.id,
      updates
    })
    return stampBotHost(hostId, bot)
  } finally {
    await endUpdate()
  }
}

/** Takes a fact out of the bot's MEMORY.md on its host, so no turn end puts it back. */
export async function forgetBotMemory(bot: BotRef, fact: string): Promise<void> {
  await callBotRpc(bot, 'bots.memory.forget', { botId: bot.id, fact })
}

/** A new fact in the bot's MEMORY.md, or `fact` (its words as shown) reworded. */
export async function editBotMemory(bot: BotRef, text: string, fact?: string): Promise<void> {
  await callBotRpc(bot, 'bots.memory.edit', { botId: bot.id, text, ...(fact ? { fact } : {}) })
}

/** The changes to the bot's MEMORY.md, newest first. */
export async function readBotMemoryHistory(bot: BotRef): Promise<BotMemoryHistoryView[]> {
  const { rows } = await callBotRpc<{ rows: BotMemoryHistoryView[] }>(bot, 'bots.memory.history', {
    botId: bot.id
  })
  return rows
}

/** Undoes one change; false when the file no longer had anything of it to undo. */
export async function undoBotMemoryChange(bot: BotRef, id: string): Promise<boolean> {
  const { undone } = await callBotRpc<{ undone: boolean }>(bot, 'bots.memory.undo', {
    botId: bot.id,
    id
  })
  return undone
}

/** Keeps the bot's Chat, its Home tab, or creates one if it has none that still fits. */
export async function openBotChat(bot: BotRef): Promise<string> {
  const { sessionId } = await callBotRpc<{ sessionId: string }>(bot, 'bots.chat.open', {
    botId: bot.id
  })
  await refreshBotHost(bot.hostId)
  return sessionId
}

/** A new Home Chat; the old one stops, leaves the tab bar and stays in history. */
export async function newBotHomeChat(bot: BotRef): Promise<string> {
  const { sessionId } = await callBotRpc<{ sessionId: string }>(bot, 'bots.chat.reset', {
    botId: bot.id
  })
  await refreshBotHost(bot.hostId)
  return sessionId
}

/** A new conversation with the bot beside its Chat, on its agent or `agent`, with its preamble. */
export async function startBotSession(
  bot: BotRef,
  params: Omit<BotSessionStartParams, 'botId'>
): Promise<string> {
  const { sessionId } = await callBotRpc<{ sessionId: string }>(bot, 'bots.session.start', {
    ...params,
    botId: bot.id
  })
  return sessionId
}

/** Tells the bot of a workspace the owner handed it, already under its home; the chat it was told in. */
export async function takeOverWorkspace(
  bot: BotRef,
  params: Omit<BotTakeOverParams, 'botId'>
): Promise<string> {
  const { sessionId } = await callBotRpc<{ sessionId: string }>(bot, 'bots.takeOver', {
    ...params,
    botId: bot.id
  })
  return sessionId
}

/** A square 512 px PNG (base64) becomes the bot's picture, kept in its home. */
export async function uploadBotAvatar(target: BotRef, png: string): Promise<Bot> {
  const { bot } = await callBotRpc<{ bot: Bot }>(target, 'bots.avatar.upload', {
    botId: target.id,
    png
  })
  await refreshBotHost(target.hostId)
  return stampBotHost(target.hostId, bot)
}

/** The uploaded picture as base64 PNG, or null when the bot has none. */
export async function readBotAvatarPng(bot: BotRef): Promise<string | null> {
  const { png } = await callBotRpc<{ png: string | null }>(bot, 'bots.avatar.read', {
    botId: bot.id
  })
  return png
}

export async function deleteBot(
  bot: BotRef,
  params: Omit<BotDeleteParams, 'botId'> = {}
): Promise<void> {
  await callBotRpc(bot, 'bots.delete', { ...params, botId: bot.id })
  await refreshBotHost(bot.hostId)
}

/** False when the home is not in the catalog (or not reachable) yet. */
export function openBotHome(bot: Bot): boolean {
  const opened = activateAndRevealFolderWorkspace(bot.folderWorkspaceId, {
    executionHostId: bot.hostId,
    // Bots are not rows of the workspace list, so there is nothing there to reveal.
    revealInSidebar: false
  })
  return opened !== false
}

/**
 * The bot's page on its Home tab, whatever tab was last open there. False when its home can't open yet.
 * `draft` is added to Home's unsent message, never sent, and its composer takes focus.
 */
export async function openBotHomeTab(bot: Bot, options?: { draft?: string }): Promise<boolean> {
  // Home exists before the page opens, so the page lands on it rather than on a new terminal.
  const chatSessionId = await openBotChat(bot).catch((error: unknown) => {
    console.error('Failed to open the bot chat:', error)
    return null
  })
  // The home must be in the catalog before it can open.
  await useAppStore
    .getState()
    .fetchFolderWorkspaces({ runtimeEnvironmentId: runtimeTargetEnvironmentId(botTarget(bot)) })
  if (!openBotHome(bot)) {
    return false
  }
  if (chatSessionId) {
    const worktreeId = folderWorkspaceKey(bot.folderWorkspaceId)
    // An open Home switches here; one not in this window yet opens when the host's activation arrives.
    if (!activateStructuredAgentSessionById({ worktreeId, sessionId: chatSessionId })) {
      activateStructuredAgentSessionTabOnOwner(worktreeId, chatSessionId)
    }
    if (options?.draft) {
      appendNativeChatDraftCache(structuredAgentSessionDraftScopeKey(chatSessionId), options.draft)
      // The draft lands once, here: the cache reaches a mounted composer and seeds one that mounts
      // later. The focus request after the activation only puts the caret after it, adding nothing.
      requestNativeChatComposerFocus(structuredAgentSessionTabId(chatSessionId), {
        revealDraft: true
      })
    }
  }
  return true
}

/** Reads the host's list first when nothing has loaded it yet. False for no such bot. */
export async function openBotHomeTabById(ref: BotRef): Promise<boolean> {
  const find = (): Bot | undefined => readHostBots(ref.hostId).find((bot) => bot.id === ref.id)
  if (!find()) {
    await refreshBotHost(ref.hostId)
  }
  const bot = find()
  return bot ? openBotHomeTab(bot) : false
}
