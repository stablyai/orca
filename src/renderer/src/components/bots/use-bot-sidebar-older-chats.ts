// The bot sidebar's split of settled chats untouched for a day under "Show N older": what this client
// knows holds a chat (tabs, focus, attention, reveal, what changed), fed to the shared rule.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNow } from '@/lib/window-activity/use-now'
import { useAppStore } from '@/store'
import { selectFrontTab } from '@/store/slices/tabs/active-tab-selection'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import {
  botChatOutcomeSignature,
  splitOlderBotSidebarChats,
  type OlderBotSidebarChats
} from '../../../../shared/bots/bot-sidebar-older-chats'
import type { BotSidebarChatView } from '../../../../shared/bots/bot-sidebar-tree'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import { useBotWorkerWorkspaceStatuses } from './use-bot-worker-statuses'

/** How often ages are re-read, so a chat a day old folds without a new chat read. */
const OLDER_CHATS_CLOCK_MS = 5 * 60_000

type ChatChanges = { signatures: Map<string, string>; changedAt: Map<string, number> }

/** Per bot row: each chat's last seen row and when this client saw it change. Outlives virtual unmounts. */
const changesByBot = new Map<string, ChatChanges>()

/** Per bot row: the chats folded last time it drew, so a row remounting under the pointer or on a stale
 *  read keeps its folds instead of listing everything first. */
const olderByBot = new Map<string, ReadonlySet<string>>()

export function pruneBotSidebarOlderChats(liveKeys: ReadonlySet<string>): void {
  for (const map of [changesByBot, olderByBot]) {
    for (const key of map.keys()) {
      if (!liveKeys.has(key)) {
        map.delete(key)
      }
    }
  }
}

/** Notes which chats' rows changed since the last read this client saw; the first read sets no times,
 *  so a backlog folds at once. Idempotent per read. */
function observeChatChanges(
  entryKey: string,
  chats: readonly BotChatTreeChat[]
): Map<string, number> {
  const seen = changesByBot.get(entryKey) ?? { signatures: new Map(), changedAt: new Map() }
  changesByBot.set(entryKey, seen)
  const now = Date.now()
  const present = new Set<string>()
  for (const chat of chats) {
    present.add(chat.chatId)
    const signature = botChatOutcomeSignature(chat)
    const previous = seen.signatures.get(chat.chatId)
    if (previous !== undefined && previous !== signature) {
      seen.changedAt.set(chat.chatId, now)
    }
    seen.signatures.set(chat.chatId, signature)
  }
  for (const chatId of seen.signatures.keys()) {
    if (!present.has(chatId)) {
      seen.signatures.delete(chatId)
      seen.changedAt.delete(chatId)
    }
  }
  return new Map(seen.changedAt)
}

/** Worker states that keep a workspace's chat listed, as this client sees them before the host says. */
const ATTENTION = new Set(['permission', 'working', 'monitoring'])

export function useBotSidebarOlderChats(input: {
  entryKey: string
  folderWorkspaceId: string
  chats: readonly BotChatTreeChat[]
  views: readonly BotSidebarChatView<Worktree>[]
  workspaces: readonly Worktree[]
  workspaceChats: Readonly<Record<string, string>>
  lineageChildrenByParentIdentity: ReadonlyMap<string, Worktree[]>
  /** Host-side live workspaces (`botLiveWorkspaceIds`). */
  liveLineIds: ReadonlySet<string>
  activeLineId: string | null
  reveal: { chatId?: string; lineIds: readonly string[] } | null
  /** The read is the last good one after a failed refresh: nothing new folds on it. */
  stale: boolean
  /** The owner is over or in the bot's list (a menu or inline rename included): nothing new folds under them. */
  interacting: boolean
}): OlderBotSidebarChats<Worktree> {
  const homeKey = useMemo(
    () => folderWorkspaceKey(input.folderWorkspaceId),
    [input.folderWorkspaceId]
  )
  const homeTabs = useAppStore((s) => s.unifiedTabsByWorktree[homeKey])
  const frontSessionId = useAppStore((s) => {
    if ((s.activeWorkspaceKey ?? s.activeWorktreeId) !== homeKey) {
      return null
    }
    const tab = selectFrontTab(s)
    return tab?.contentType === 'agent-session' ? tab.entityId : null
  })
  const now = useNow(OLDER_CHATS_CLOCK_MS)
  const { entryKey, chats, workspaces, lineageChildrenByParentIdentity } = input
  const childrenOf = useMemo(
    () => (line: Worktree) =>
      lineageChildrenByParentIdentity.get(getWorktreeHostIdentity(line)) ?? [],
    [lineageChildrenByParentIdentity]
  )
  // Every line and its descendants, so a worker waiting on the owner deep in a quiet chat's tree holds it.
  const allLineIds = useMemo(() => {
    const ids = new Set<string>()
    const walk = (line: Worktree): void => {
      if (!ids.has(line.id)) {
        ids.add(line.id)
        childrenOf(line).forEach(walk)
      }
    }
    workspaces.forEach(walk)
    return [...ids]
  }, [workspaces, childrenOf])
  const statuses = useBotWorkerWorkspaceStatuses(allLineIds)
  const changedAt = useMemo(() => observeChatChanges(entryKey, chats), [entryKey, chats])
  const split = useMemo(() => {
    // A stale read folds nothing new (none at all before any good one); a held list keeps what it showed,
    // except on its first draw, which folds as usual.
    const shown = olderByBot.get(entryKey)
    const keepFoldedOnly = input.stale
      ? (shown ?? new Set<string>())
      : input.interacting
        ? (shown ?? null)
        : null
    const focusedAt = new Map<string, number>()
    for (const tab of homeTabs ?? []) {
      if (tab.contentType === 'agent-session' && tab.lastFocusedAt !== undefined) {
        focusedAt.set(tab.entityId, Math.max(tab.lastFocusedAt, focusedAt.get(tab.entityId) ?? 0))
      }
    }
    const heldLineIds = new Set(input.liveLineIds)
    for (const [id, status] of statuses) {
      if (ATTENTION.has(status)) {
        heldLineIds.add(id)
      }
    }
    for (const id of [input.activeLineId, ...(input.reveal?.lineIds ?? [])]) {
      if (id) {
        heldLineIds.add(id)
      }
    }
    const heldSessionIds = new Set(
      [frontSessionId, input.reveal?.chatId].filter((id): id is string => Boolean(id))
    )
    return splitOlderBotSidebarChats(input.views, {
      now,
      focusedAt,
      heldSessionIds,
      changedAt,
      heldLineIds,
      workspaces,
      workspaceChats: input.workspaceChats,
      childrenOf,
      keepFoldedOnly
    })
    // Fields of `input` are listed one by one; the object itself is new each render.
  }, [
    homeTabs,
    statuses,
    input.liveLineIds,
    input.activeLineId,
    input.reveal,
    frontSessionId,
    input.views,
    now,
    changedAt,
    workspaces,
    input.workspaceChats,
    childrenOf,
    input.interacting,
    input.stale,
    entryKey
  ])
  useEffect(() => {
    olderByBot.set(entryKey, new Set(split.older.map((view) => view.chat.chatId)))
  }, [entryKey, split])
  return split
}

/** Whether the owner is over or in a list: the pointer over it, or focus inside (portaled menus too,
 *  through React's tree). A blur that focus re-enters in the same task never reads as leaving. */
export function useListHold(): {
  held: boolean
  handlers: {
    onPointerEnter: () => void
    onPointerLeave: () => void
    onFocus: () => void
    onBlur: () => void
  }
} {
  const [pointerIn, setPointerIn] = useState(false)
  const [focusIn, setFocusIn] = useState(false)
  const inside = useRef(false)
  const handlers = useMemo(
    () => ({
      onPointerEnter: () => setPointerIn(true),
      onPointerLeave: () => setPointerIn(false),
      onFocus: () => {
        inside.current = true
        setFocusIn(true)
      },
      onBlur: () => {
        inside.current = false
        setTimeout(() => {
          if (!inside.current) {
            setFocusIn(false)
          }
        }, 0)
      }
    }),
    []
  )
  return { held: pointerIn || focusIn, handlers }
}
