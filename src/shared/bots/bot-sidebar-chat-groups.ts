import { CHAT_TREE_CAPS, type BotChatTreeChat, type BotChatTreeWorker } from './bot-chat-tree'
import {
  canonicalExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../execution-host/execution-host'
import {
  composeWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../worktree/host-qualified-identity'

export type BotSidebarChatGroup<T> = { chat: BotChatTreeChat; workspaces: T[] }

/** The chats the sidebar lists: only those with an open tab; an older host doesn't say, so its open chats all list. */
export function botSidebarListedChats(chats: readonly BotChatTreeChat[]): BotChatTreeChat[] {
  return chats.filter((chat) => !chat.closed && chat.tab !== false)
}

/** The sidebar's chats (those with an open tab) in the panel's order, each with the bot workspaces its
 *  workers have, live ones first. One no chat has goes under Home Chat; one whose chat has no tab is left out. */
export function groupBotWorkspacesByChat<T extends { id: string }>(
  chats: readonly BotChatTreeChat[],
  workspaces: readonly T[],
  workspaceChats: Readonly<Record<string, string>>
): BotSidebarChatGroup<T>[] {
  const open = botSidebarListedChats(chats)
  const listed = [
    ...open.filter((chat) => chat.origin === 'home'),
    ...open.filter((chat) => chat.origin !== 'home')
  ]
  const groups = listed.map((chat): BotSidebarChatGroup<T> => ({ chat, workspaces: [] }))
  const byChatId = new Map(groups.map((group) => [group.chat.chatId, group]))
  // Within a chat, a workspace waiting on the owner leads, then running ones; Smart order otherwise.
  const ranked = rankBotWorkspacesByLive(chats, workspaces)
  const homeId = chats.find((chat) => chat.origin === 'home' && !chat.closed)?.chatId
  for (const workspace of ranked) {
    const chatId = workspaceChats[workspace.id] ?? homeId
    ;(chatId === undefined ? undefined : byChatId.get(chatId))?.workspaces.push(workspace)
  }
  return groups
}

/** The workspaces with any a worker waits on the owner in first, then running ones, else in given order. */
export function rankBotWorkspacesByLive<T extends { id: string }>(
  chats: readonly BotChatTreeChat[],
  workspaces: readonly T[]
): T[] {
  const rank = liveWorkspaceRanks(chats)
  return [...workspaces].sort((a, b) => (rank.get(a.id) ?? 2) - (rank.get(b.id) ?? 2))
}

/** Each live workspace's rank: 0 when a worker in it waits on the owner, 1 while one runs. */
function liveWorkspaceRanks(chats: readonly BotChatTreeChat[]): Map<string, number> {
  const rank = new Map<string, number>()
  for (const chat of chats) {
    for (const worker of chat.running) {
      if (worker.worktreeId) {
        const next = worker.state === 'needs-you' ? 0 : 1
        rank.set(worker.worktreeId, Math.min(next, rank.get(worker.worktreeId) ?? next))
      }
    }
  }
  return rank
}

/** The workspaces some worker still runs or waits in. */
export function botLiveWorkspaceIds(chats: readonly BotChatTreeChat[]): ReadonlySet<string> {
  return new Set(liveWorkspaceRanks(chats).keys())
}

/** A chat's lines on the left: every live one, then the last finished few, then steps of 8. Lines come
 *  live first, as `groupBotWorkspacesByChat` orders them. */
export function pageChatLines(
  lines: readonly { id: string }[],
  liveIds: ReadonlySet<string>,
  steps: number
): { shown: number; remaining: number } {
  const live = lines.filter((line) => liveIds.has(line.id)).length
  return pageSidebarList(lines.length, live + CHAT_TREE_CAPS.finishedShown, steps)
}

export type BotSidebarLineNote = 'handed-over' | 'from-closed-chat'

/** Each workspace's note from its newest loaded worker: a hand-over or a closed chat's still-running worker. */
export function botSidebarLineNotes(
  chats: readonly BotChatTreeChat[]
): Map<string, BotSidebarLineNote> {
  const newest = new Map<string, BotChatTreeWorker>()
  for (const chat of chats) {
    for (const worker of [...chat.running, ...chat.finished]) {
      const seen = worker.worktreeId ? newest.get(worker.worktreeId) : undefined
      if (worker.worktreeId && (!seen || worker.startedAt > seen.startedAt)) {
        newest.set(worker.worktreeId, worker)
      }
    }
  }
  const notes = new Map<string, BotSidebarLineNote>()
  for (const [worktreeId, worker] of newest) {
    if (worker.note === 'handed-over' || worker.note === 'from-closed-chat') {
      notes.set(worktreeId, worker.note)
    }
  }
  return notes
}

/** A paired computer's canonical id, or null for this computer's own (local, SSH, or unstated). */
function pairedRuntimeHost(hostId: string | undefined): ExecutionHostId | null {
  const host = canonicalExecutionHostId(hostId)
  return host?.startsWith('runtime:') ? host : null
}

/** A sidebar line's workspace key in this client's terms: a paired computer's, else this computer,
 *  which runs its local and SSH workspaces alike. */
export function botLineWorkspaceKey(line: { id: string; hostId?: string }): HostScopedWorktreeKey {
  return composeWorktreeHostIdentity(
    pairedRuntimeHost(line.hostId) ?? LOCAL_EXECUTION_HOST_ID,
    line.id
  )
}

/** Each workspace's newest loaded worker, by the same key its line has. A worker names a host only for
 *  a paired computer; with none it is on the computer that answered, `ownerHostId` in this client's terms. */
export function botSidebarLineWorkers(
  chats: readonly BotChatTreeChat[],
  ownerHostId: string
): Map<HostScopedWorktreeKey, BotChatTreeWorker> {
  const owner = pairedRuntimeHost(ownerHostId) ?? LOCAL_EXECUTION_HOST_ID
  const newest = new Map<HostScopedWorktreeKey, BotChatTreeWorker>()
  for (const chat of chats) {
    for (const worker of [...chat.running, ...chat.finished]) {
      if (!worker.worktreeId) {
        continue
      }
      const key = composeWorktreeHostIdentity(
        pairedRuntimeHost(worker.hostId) ?? owner,
        worker.worktreeId
      )
      const seen = newest.get(key)
      if (!seen || worker.startedAt > seen.startedAt) {
        newest.set(key, worker)
      }
    }
  }
  return newest
}

/** How many of a capped list show after `steps` reveals of 8, and how many stay hidden. */
function pageSidebarList(
  total: number,
  first: number,
  steps: number
): { shown: number; remaining: number } {
  const shown = Math.min(total, first + steps * CHAT_TREE_CAPS.step)
  return { shown, remaining: total - shown }
}
