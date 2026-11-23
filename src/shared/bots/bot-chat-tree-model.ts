// Places a bot's workers under the chats that started them, for `bots.chatTree`.
import {
  sessionWorkerAgentState,
  sessionWorkerIsRunning,
  sessionWorkerRestsOnAsk,
  type OrchestrationSessionWorker
} from '../orchestration-session-workers'
import { toRuntimeExecutionHostId } from '../execution-host/execution-host'
import { clipActivityTitle } from './bot-activity-recorded-workers'
import {
  CHAT_TREE_CAPS,
  type BotChatTreeChat,
  type BotChatTreeRead,
  type BotChatTreeWorker
} from './bot-chat-tree'

/** A chat's own facts, before its workers are placed. */
export type BotChatFacts = Omit<
  BotChatTreeChat,
  'running' | 'runningTotal' | 'finished' | 'finishedTotal' | 'failedTotal'
>

/** The id a bot without a Home Chat yet lists its Home row by; opening it starts one. */
export const NO_HOME_CHAT_ID = ''

/** The Home row's title, the name the bot's Home tab goes by. */
export const HOME_CHAT_TITLE = 'Home Chat'

/** One of the bot's Dispatches, with the root chat its creator chain leads to (null: none). */
export type BotChatTreeDispatch = {
  id: string
  chatId: string | null
  settled: boolean
  failed: boolean
  /** Settled: when; else when it started. */
  at: number
  worktreeId: string | null
  /** Its Task's title, for search; absent when the host read none. */
  title?: string
}

/** A row that is not a Dispatch of the bot's: a handed-over agent or a terminal-only automation run. */
export type BotChatTreeExtra = { worker: BotChatTreeWorker; settled: boolean; at: number }

/** Where a chat's finished list resumes: just past the last worker shown. */
export type BotChatTreeCursor = { at: number; key: string }

export type BotChatTreePage = { chatId: string; after?: BotChatTreeCursor }

/** A Dispatch under the chat it shows in. */
export type BotChatTreePlaced = {
  dispatch: BotChatTreeDispatch
  chatId: string
  note?: BotChatTreeWorker['note']
}

function homeIdOf(chats: readonly BotChatFacts[]): string {
  return chats.find((chat) => chat.origin === 'home' && !chat.closed)?.chatId ?? NO_HOME_CHAT_ID
}

/** Where each Dispatch shows: its chat; Home when it has none, or while its closed chat's worker runs. */
export function placeBotChatDispatches(
  chats: readonly BotChatFacts[],
  dispatches: readonly BotChatTreeDispatch[]
): BotChatTreePlaced[] {
  const home = homeIdOf(chats)
  const byId = new Map(chats.map((chat) => [chat.chatId, chat]))
  return dispatches.map((dispatch) => {
    const chat = dispatch.chatId ? byId.get(dispatch.chatId) : undefined
    if (!chat) {
      return { dispatch, chatId: home }
    }
    if (chat.closed && !dispatch.settled) {
      return { dispatch, chatId: home, note: 'from-closed-chat' }
    }
    return { dispatch, chatId: chat.chatId }
  })
}

/** A finished row before its record is read: a Dispatch, or an extra that needs none. */
type FinishedRef = { key: string; at: number; placed?: BotChatTreePlaced; extra?: BotChatTreeExtra }

/** Newest first; the key breaks ties, so a cursor names one place in the list. */
function finishedOrder(a: FinishedRef, b: FinishedRef): number {
  return b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)
}

/** A chat's finished list as a surface shows it: the host's newest plus the pages it read, each once,
 *  in list order. Rows read earlier stay, so one finishing between pages never opens a gap; one running
 *  again (its terminal turned up) shows only as running. */
export function mergeShownFinished(
  newest: readonly BotChatTreeWorker[],
  loaded: readonly BotChatTreeWorker[],
  runningKeys?: ReadonlySet<string>
): BotChatTreeWorker[] {
  const retained = runningKeys ? loaded.filter((worker) => !runningKeys.has(worker.key)) : loaded
  const byKey = new Map([...retained, ...newest].map((worker) => [worker.key, worker]))
  const order = (a: BotChatTreeWorker, b: BotChatTreeWorker): number =>
    finishedOrder({ ...botChatTreeCursor(a), key: a.key }, { ...botChatTreeCursor(b), key: b.key })
  return [...byKey.values()].sort(order)
}

/** A worker's place in its chat's finished list, for the next page's cursor. */
export function botChatTreeCursor(worker: BotChatTreeWorker): BotChatTreeCursor {
  return { at: worker.settledAt ?? worker.startedAt, key: worker.key }
}

type ChatRefs = {
  running: BotChatTreePlaced[]
  runningExtras: BotChatTreeWorker[]
  finished: FinishedRef[]
}

/** With `workers`, an open Dispatch whose record reads ended (exited without reporting, or its terminal gone) is
 *  history, as Activity shows it: in its own chat, where it stays once settled, keyed by start as its cursor is. */
function refsByChat(
  placed: readonly BotChatTreePlaced[],
  extras: readonly BotChatTreeExtra[],
  home: string,
  workers?: ReadonlyMap<string, OrchestrationSessionWorker>
): Map<string, ChatRefs> {
  const byChat = new Map<string, ChatRefs>()
  const refs = (chatId: string): ChatRefs => {
    let found = byChat.get(chatId)
    if (!found) {
      found = { running: [], runningExtras: [], finished: [] }
      byChat.set(chatId, found)
    }
    return found
  }
  for (const entry of placed) {
    const worker = entry.dispatch.settled ? undefined : workers?.get(entry.dispatch.id)
    if (worker && !sessionWorkerIsRunning(worker)) {
      // A closed chat's open worker waited under Home; ended, it goes back to its chat. Its outcome is the record's.
      const chatId = (entry.note === 'from-closed-chat' && entry.dispatch.chatId) || entry.chatId
      const dispatch = { ...entry.dispatch, failed: worker.state === 'failed' }
      const key = `worker:${dispatch.id}`
      refs(chatId).finished.push({ key, at: worker.startedAt, placed: { dispatch, chatId } })
      continue
    }
    const chat = refs(entry.chatId)
    if (entry.dispatch.settled) {
      chat.finished.push({
        key: `worker:${entry.dispatch.id}`,
        at: entry.dispatch.at,
        placed: entry
      })
    } else {
      chat.running.push(entry)
    }
  }
  for (const extra of extras) {
    const chat = refs(home)
    if (extra.settled) {
      chat.finished.push({ key: extra.worker.key, at: extra.at, extra })
    } else {
      chat.runningExtras.push(extra.worker)
    }
  }
  for (const chat of byChat.values()) {
    chat.finished.sort(finishedOrder)
  }
  return byChat
}

function finishedSlice(finished: readonly FinishedRef[], page?: BotChatTreePage): FinishedRef[] {
  if (!page) {
    return finished.slice(0, CHAT_TREE_CAPS.finishedShown)
  }
  const { after } = page
  const start = after
    ? finished.findIndex((ref) => finishedOrder(ref, { key: after.key, at: after.at }) > 0)
    : 0
  return start < 0 ? [] : finished.slice(start, start + CHAT_TREE_CAPS.step)
}

/** The Dispatches whose worker records a read needs: the running ones, and the finished rows it shows. */
export function botChatTreeDispatchIds(
  chats: readonly BotChatFacts[],
  placed: readonly BotChatTreePlaced[],
  extras: readonly BotChatTreeExtra[],
  page?: BotChatTreePage
): string[] {
  const ids: string[] = []
  for (const [chatId, chat] of refsByChat(placed, extras, homeIdOf(chats))) {
    // Every running record, even for one chat's page: one that reads ended moves to its own chat's history.
    ids.push(...chat.running.map((entry) => entry.dispatch.id))
    if (page && page.chatId !== chatId) {
      continue
    }
    for (const ref of finishedSlice(chat.finished, page)) {
      if (ref.placed) {
        ids.push(ref.placed.dispatch.id)
      }
    }
  }
  return ids
}

function workerState(worker: OrchestrationSessionWorker): BotChatTreeWorker['state'] {
  if (!sessionWorkerIsRunning(worker)) {
    return worker.state === 'failed' ? 'failed' : 'done'
  }
  // Out of contact too: its open ask is the last thing it said, so it never reads as running.
  if (sessionWorkerRestsOnAsk(worker)) {
    return 'asking-bot'
  }
  // Never a spinner and a timer for a worker no host can see.
  if (worker.state === 'unverifiable') {
    return 'unreachable'
  }
  const state = sessionWorkerAgentState(worker)
  return state === 'blocked' || state === 'waiting' ? 'needs-you' : 'running'
}

/** A Dispatch's row; a record that could not be read still shows, so the totals stay true. */
export function botChatTreeDispatchWorker(
  { dispatch, note }: BotChatTreePlaced,
  worker: OrchestrationSessionWorker | undefined
): BotChatTreeWorker {
  const key = `worker:${dispatch.id}`
  if (!worker) {
    return {
      key,
      // Its Task's title, when the worker record could not be read.
      title: dispatch.title ? clipActivityTitle(dispatch.title) : '',
      state: dispatch.settled ? (dispatch.failed ? 'failed' : 'done') : 'running',
      startedAt: dispatch.at,
      ...(dispatch.settled ? { settledAt: dispatch.at } : {}),
      ...(note ? { note } : {}),
      dispatchId: dispatch.id
    }
  }
  const state = workerState(worker)
  return {
    key,
    title: clipActivityTitle(worker.title),
    state,
    ...(state === 'running' && worker.backgroundWait ? { waitsOnBackground: true as const } : {}),
    startedAt: worker.startedAt,
    // The list's own order and cursor read this time.
    ...(dispatch.settled ? { settledAt: dispatch.at } : {}),
    ...(worker.worktreeId ? { worktreeId: worker.worktreeId } : {}),
    ...(worker.paneKey ? { paneKey: worker.paneKey } : {}),
    ...(note ? { note } : {}),
    dispatchId: worker.dispatchId,
    ...(worker.hostEnvironmentId
      ? { hostId: toRuntimeExecutionHostId(worker.hostEnvironmentId) }
      : {}),
    ...(worker.agent ? { agent: worker.agent } : {}),
    ...(worker.summary ? { summary: worker.summary } : {}),
    ...(state === 'failed' && !worker.address ? { neverStarted: true as const } : {}),
    host: worker.host
  }
}

const runningOrder = (a: BotChatTreeWorker, b: BotChatTreeWorker): number =>
  Number(b.state === 'needs-you') - Number(a.state === 'needs-you') || b.startedAt - a.startedAt

function failedCount(finished: readonly FinishedRef[]): number {
  return finished.filter((ref) =>
    ref.placed ? ref.placed.dispatch.failed : ref.extra?.worker.state === 'failed'
  ).length
}

/** The tree with every chat's running workers and the last finished ones (or one chat's next page). */
export function buildBotChatTree(input: {
  chats: readonly BotChatFacts[]
  placed: readonly BotChatTreePlaced[]
  /** The worker records read for `botChatTreeDispatchIds`. */
  workers: ReadonlyMap<string, OrchestrationSessionWorker>
  extras?: readonly BotChatTreeExtra[]
  /** Workspaces under the bot that no Dispatch places, such as ones moved in by hand. */
  homeWorkspaceIds?: readonly string[]
  page?: BotChatTreePage
}): BotChatTreeRead {
  const home = homeIdOf(input.chats)
  const extras = input.extras ?? []
  const byChat = refsByChat(input.placed, extras, home, input.workers)
  const facts = input.chats.some((chat) => chat.chatId === home)
    ? input.chats
    : [
        {
          chatId: NO_HOME_CHAT_ID,
          title: HOME_CHAT_TITLE,
          origin: 'home' as const,
          live: 'idle' as const,
          lastActiveAt: 0,
          unread: false,
          closed: false
        },
        ...input.chats
      ]
  const chats = facts
    .filter((chat) => !input.page || chat.chatId === input.page.chatId)
    .map((chat): BotChatTreeChat => {
      const refs = byChat.get(chat.chatId) ?? { running: [], runningExtras: [], finished: [] }
      const running = [
        ...refs.running.map((entry) =>
          botChatTreeDispatchWorker(entry, input.workers.get(entry.dispatch.id))
        ),
        ...refs.runningExtras
      ].sort(runningOrder)
      return {
        ...chat,
        running,
        runningTotal: running.length,
        finished: finishedSlice(refs.finished, input.page).map((ref) =>
          ref.placed
            ? botChatTreeDispatchWorker(ref.placed, input.workers.get(ref.placed.dispatch.id))
            : ref.extra!.worker
        ),
        finishedTotal: refs.finished.length,
        failedTotal: failedCount(refs.finished)
      }
    })
  return {
    chats,
    workspaceChats: botWorkspaceChats(input.placed, extras, home, input.homeWorkspaceIds)
  }
}

/** Each workspace under the chat of its newest Dispatch; one no Dispatch ran in sits under Home. */
function botWorkspaceChats(
  placed: readonly BotChatTreePlaced[],
  extras: readonly BotChatTreeExtra[],
  home: string,
  homeWorkspaceIds: readonly string[] = []
): Record<string, string> {
  const newest = new Map<string, { chatId: string; at: number }>()
  const consider = (worktreeId: string | null | undefined, chatId: string, at: number): void => {
    const current = worktreeId ? newest.get(worktreeId) : undefined
    if (worktreeId && (!current || current.at < at)) {
      newest.set(worktreeId, { chatId, at })
    }
  }
  for (const { dispatch, chatId } of placed) {
    consider(dispatch.worktreeId, chatId, dispatch.at)
  }
  // A workspace a Dispatch ran in stays with that Dispatch's chat, whatever else works there later.
  const placedWorktrees = new Set(newest.keys())
  for (const extra of extras) {
    if (!placedWorktrees.has(extra.worker.worktreeId ?? '')) {
      consider(extra.worker.worktreeId, home, extra.at)
    }
  }
  const map: Record<string, string> = {}
  for (const worktreeId of homeWorkspaceIds) {
    map[worktreeId] = home
  }
  for (const [worktreeId, { chatId }] of newest) {
    map[worktreeId] = chatId
  }
  return map
}
