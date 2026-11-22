// A bot's chats in the left list with the workspaces their workers made: one model the desktop sidebar
// and the phone's host list both draw, so order, folds, paging and trailing text never diverge.
import {
  CHAT_TREE_CAPS,
  chatFoldCounts,
  type BotChatFold,
  type BotChatTranslate,
  type BotChatTreeChat,
  type ChatFoldCounts
} from './bot-chat-tree'
import {
  botLiveWorkspaceIds,
  botSidebarLineNotes,
  groupBotWorkspacesByChat,
  pageChatLines,
  rankBotWorkspacesByLive,
  type BotSidebarLineNote
} from './bot-sidebar-chat-groups'

/** What a chat row's right edge says: a folded chat's live counts, else its time; nothing while it replies. */
export type BotSidebarChatTrailing =
  | { kind: 'summary'; counts: ChatFoldCounts }
  | { kind: 'time'; at: number }

/** A chat's "Show more" for its workers: a full step reads "Show 8 more", a last partial one names its count. */
export type BotSidebarWorkerPaging = { remaining: number; label: 'step' | 'count' }

export function botSidebarWorkerPagingLabel(
  t: BotChatTranslate,
  paging: BotSidebarWorkerPaging
): string {
  return paging.label === 'step'
    ? t('bots.chats.showEightMoreWorkers', 'Show 8 more workers')
    : t('bots.chats.showMoreWorkers', 'Show {{count}} more workers', {
        count: paging.remaining,
        defaultValue_one: 'Show {{count}} more worker'
      })
}

export type BotSidebarChatView<T> = {
  chat: BotChatTreeChat
  /** It has workspaces under it, so it folds. */
  foldable: boolean
  open: boolean
  trailing: BotSidebarChatTrailing | null
  /** The workspaces shown while open: live first, then the paged rest; the open one always stays. */
  lines: T[]
  paging: BotSidebarWorkerPaging | null
  /** "Show more" steps taken; above 0, "Show fewer" applies. */
  steps: number
}

export type BotSidebarTree<T> = {
  chats: BotSidebarChatView<T>[]
  /** Workspaces no listed chat has (an automation run's, a closed chat's), shown after the chats while
   *  a worker in one runs or waits, so they don't vanish once another row is open; the open one too. */
  stray: T[]
  /** Each workspace's note: handed over, or from a closed chat. */
  notes: ReadonlyMap<string, BotSidebarLineNote>
}

/** Whether a bot's chats and workspaces list under its row. Nothing does while its host is down: no
 *  client keeps a down host's chats, so both apps show only the dimmed row, not one a stale list. */
export function botListsUnderRow(row: { folded: boolean; hostDown: boolean }): boolean {
  return !row.folded && !row.hostDown
}

/** A bot's sidebar chats from the host's read: the chats with an open tab, each with its workspaces. */
export function buildBotSidebarTree<T extends { id: string }>(input: {
  /** In `orderBotChats` order. */
  chats: readonly BotChatTreeChat[]
  /** The bot's workspaces in the list's order, hidden ones already left out. */
  workspaces: readonly T[]
  workspaceChats: Readonly<Record<string, string>>
  /** This client's fold per chat id; undefined stays folded, live or not. */
  foldOf: (chatId: string) => BotChatFold | undefined
  /** "Show more" steps taken per chat id. */
  stepsOf: (chatId: string) => number
  activeLineId: string | null
  /** A chat Orca closed since then stays listed, last, so it can be reopened from its row. */
  keepAutoClosedAfter?: number
}): BotSidebarTree<T> {
  const groups = groupBotWorkspacesByChat(
    input.chats,
    input.workspaces,
    input.workspaceChats,
    input.keepAutoClosedAfter
  )
  const liveIds = botLiveWorkspaceIds(input.chats)
  const chats = groups.map(({ chat, workspaces }): BotSidebarChatView<T> => {
    const foldable = workspaces.length > 0
    const open = foldable && input.foldOf(chat.chatId) === 'open'
    const steps = input.stepsOf(chat.chatId)
    const page = pageChatLines(workspaces, liveIds, steps)
    return {
      chat,
      foldable,
      open,
      trailing: chatTrailing(chat, foldable && !open),
      lines: workspaces.filter(
        (line, index) => index < page.shown || line.id === input.activeLineId
      ),
      paging:
        page.remaining === 0
          ? null
          : {
              remaining: page.remaining,
              label: page.remaining > CHAT_TREE_CAPS.step ? 'step' : 'count'
            },
      steps
    }
  })
  const listed = new Set(groups.flatMap((group) => group.workspaces.map((line) => line.id)))
  return {
    chats,
    stray: rankBotWorkspacesByLive(input.chats, input.workspaces).filter(
      (line) => !listed.has(line.id) && (liveIds.has(line.id) || line.id === input.activeLineId)
    ),
    notes: botSidebarLineNotes(input.chats)
  }
}

/** Folded: what runs or waits, else when it last moved. A replying chat's spinner says enough. */
function chatTrailing(chat: BotChatTreeChat, folded: boolean): BotSidebarChatTrailing | null {
  const time = chat.lastActiveAt > 0 ? ({ kind: 'time', at: chat.lastActiveAt } as const) : null
  if (folded) {
    const counts = chatFoldCounts(chat)
    return counts ? { kind: 'summary', counts } : time
  }
  return chat.live === 'replying' ? null : time
}
