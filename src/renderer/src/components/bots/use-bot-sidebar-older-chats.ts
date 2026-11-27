// The bot sidebar's split of settled chats untouched for a day under "Show N older": what this client
// knows holds a chat (tabs, focus, attention, reveal), fed to the shared rule.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNowSnapshot } from '@/lib/window-activity/use-now'
import { useAppStore } from '@/store'
import { selectFrontTab } from '@/store/slices/tabs/active-tab-selection'
import type { Bot } from '../../../../shared/bot-types'
import {
  botSidebarChatFoldTimes,
  splitOlderBotSidebarChats,
  type OlderBotSidebarChats
} from '../../../../shared/bots/bot-sidebar-older-chats'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import type { BotSidebarChatView } from '../../../../shared/bots/bot-sidebar-tree'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AppState } from '@/store/types'
import { useShallow } from 'zustand/react/shallow'
import { createWatchedAttentionReader } from './bot-sidebar-attention'

/** How often fold times are compared with the clock; a chat folds up to this late. */
const OLDER_CHATS_CLOCK_MS = 5 * 60_000

/** Per bot row: the chats folded when it last drew. Outlives virtual unmounts. */
const olderByBot = new Map<string, ReadonlySet<string>>()

export function pruneBotSidebarOlderChats(liveKeys: ReadonlySet<string>): void {
  for (const key of olderByBot.keys()) {
    if (!liveKeys.has(key)) {
      olderByBot.delete(key)
    }
  }
}

/** A chat tab in the bot's home counts for the bot only when it is the bot host's, or names no host. */
export function tabOfBotHost(tab: Tab, hostId: string): boolean {
  return (
    tab.contentType === 'agent-session' && (!tab.executionHostId || tab.executionHostId === hostId)
  )
}

/** The chat tab in front of the bot's home, read once for the whole list: its rows' current marker and
 *  the fold's hold both use it, so no row scans the tabs itself. */
export type BotHomeFrontTab = Pick<Tab, 'id' | 'entityId' | 'executionHostId'>

export function useBotHomeFrontTab(folderWorkspaceId: string): BotHomeFrontTab | null {
  const homeKey = useMemo(() => folderWorkspaceKey(folderWorkspaceId), [folderWorkspaceId])
  const front = useAppStore(
    useShallow((s) => {
      if ((s.activeWorkspaceKey ?? s.activeWorktreeId) !== homeKey) {
        return null
      }
      const tab = selectFrontTab(s)
      return tab?.contentType === 'agent-session'
        ? { id: tab.id, entityId: tab.entityId, executionHostId: tab.executionHostId }
        : null
    })
  )
  return front
}

export function useBotSidebarOlderChats(input: {
  bot: Pick<Bot, 'hostId' | 'folderWorkspaceId'>
  entryKey: string
  views: readonly BotSidebarChatView<Worktree>[]
  /** The read's every chat, those with no row too: their workers are evidence of a shared workspace id. */
  readChats: readonly BotChatTreeChat[]
  /** Every root workspace of the bot, sleeping ones too: attention under a hidden root still holds. */
  workspaces: readonly Worktree[]
  workspaceChats: Readonly<Record<string, string>>
  lineageChildrenByParentIdentity: ReadonlyMap<string, Worktree[]>
  /** Host-side live workspaces (`botLiveWorkspaceIds`). */
  liveLineIds: ReadonlySet<string>
  activeLineId: string | null
  reveal: { chatId?: string; lineIds: readonly string[] } | null
  front: BotHomeFrontTab | null
  /** A read landed since this list opened, its last refresh did not fail and none is pending: only then
   *  does anything new fold. */
  fresh: boolean
  /** The owner is over or in the list (a menu or inline rename included), or it is still mounting. */
  held: boolean
}): OlderBotSidebarChats<Worktree> {
  const { bot, entryKey, views, workspaces, lineageChildrenByParentIdentity, fresh, front } = input
  const homeKey = useMemo(() => folderWorkspaceKey(bot.folderWorkspaceId), [bot.folderWorkspaceId])
  const homeTabs = useAppStore((s) => s.unifiedTabsByWorktree[homeKey])
  // A front tab of unknown host holds conservatively; one stamped with another host never does.
  const frontSessionId =
    front && (!front.executionHostId || front.executionHostId === bot.hostId)
      ? front.entityId
      : null
  const childrenOf = useCallback(
    (line: Worktree) => lineageChildrenByParentIdentity.get(getWorktreeHostIdentity(line)) ?? [],
    [lineageChildrenByParentIdentity]
  )
  // Fold times from the read, tabs, open line and reveal; workspace attention is checked below, only for
  // chats already due.
  const baseTimes = useMemo(() => {
    const focusedAt = new Map<string, number>()
    for (const tab of homeTabs ?? []) {
      // Each stamp is checked before it competes, so a malformed duplicate can't hide a valid one.
      const at = tab.lastFocusedAt
      if (
        tabOfBotHost(tab, bot.hostId) &&
        typeof at === 'number' &&
        Number.isFinite(at) &&
        at > 0
      ) {
        focusedAt.set(tab.entityId, Math.max(at, focusedAt.get(tab.entityId) ?? 0))
      }
    }
    const heldLineIds = new Set(input.liveLineIds)
    for (const id of [input.activeLineId, ...(input.reveal?.lineIds ?? [])]) {
      if (id) {
        heldLineIds.add(id)
      }
    }
    return botSidebarChatFoldTimes(
      views.map((view) => view.chat),
      {
        focusedAt,
        heldSessionIds: new Set(
          [frontSessionId, input.reveal?.chatId].filter((id): id is string => Boolean(id))
        ),
        heldLineIds,
        readChats: input.readChats,
        workspaces,
        workspaceChats: input.workspaceChats,
        childrenOf,
        identityOf: getWorktreeHostIdentity
      }
    )
    // Fields of `input` are listed one by one; the object itself is new each render.
  }, [
    homeTabs,
    bot.hostId,
    input.liveLineIds,
    input.activeLineId,
    input.reveal,
    frontSessionId,
    views,
    input.readChats,
    workspaces,
    input.workspaceChats,
    childrenOf
  ])
  // The clock only counts how many fold times have passed, so a tick re-renders nothing until one does.
  const dueTimes = useMemo(
    () => [...baseTimes.values()].filter(Number.isFinite).sort((a, b) => a - b),
    [baseTimes]
  )
  const countDue = useCallback(
    (_tick: number) => {
      // The clock's ticks only ask again; admission is always the wall clock now, so a tick sampled by
      // another bot's list, or a clock set back, never admits a fold early. Folds already drawn are kept
      // apart (`olderByBot`) and only held there, never admitted by an old time.
      const now = Date.now()
      if (!Number.isFinite(now)) {
        return 0
      }
      // How many fold times are at or before now: a binary search over the sorted times.
      let low = 0
      let high = dueTimes.length
      while (low < high) {
        const middle = (low + high) >> 1
        if (dueTimes[middle]! <= now) {
          low = middle + 1
        } else {
          high = middle
        }
      }
      return low
    },
    [dueTimes]
  )
  // Wait on the clock only while a fold time is still ahead: none (a Home-only list) or all passed
  // leaves no tick that could change the count. A new time re-reads the count on that render.
  const dueCount = useNowSnapshot(OLDER_CHATS_CLOCK_MS, countDue, countDue(0) < dueTimes.length)
  const now = dueCount === 0 ? Number.NEGATIVE_INFINITY : dueTimes[dueCount - 1]!
  // The workspaces whose attention can change a fold: every line under a chat already due, and every
  // line no chat claims (whose attention nobody can place). Fewer than two due: nothing can fold, so none.
  const watched = useMemo(() => {
    const chatsByLine = new Map<string, Set<string | null>>()
    if (dueCount < 2) {
      return chatsByLine
    }
    const walked = new Set<string>()
    const walk = (line: Worktree, chatId: string | null): void => {
      const identity = `${chatId}\u0000${getWorktreeHostIdentity(line)}`
      if (walked.has(identity)) {
        return
      }
      walked.add(identity)
      const chats = chatsByLine.get(line.id) ?? new Set<string | null>()
      chats.add(chatId)
      chatsByLine.set(line.id, chats)
      childrenOf(line).forEach((child) => walk(child, chatId))
    }
    for (const line of workspaces) {
      const chatId = input.workspaceChats[line.id]
      if (chatId === undefined) {
        walk(line, null)
      } else if ((baseTimes.get(chatId) ?? Number.POSITIVE_INFINITY) <= now) {
        walk(line, chatId)
      }
    }
    return chatsByLine
  }, [dueCount, now, workspaces, input.workspaceChats, baseTimes, childrenOf])
  const watchedIds = useMemo(() => [...watched.keys()], [watched])
  // Nothing is read while fewer than two chats are due; a write re-reads only the workspaces it changed.
  const [readAttention] = useState(createWatchedAttentionReader)
  const selectAttention = useCallback(
    (state: AppState) => readAttention(state, watchedIds),
    [readAttention, watchedIds]
  )
  // Compared item by item, so a write that changes none of them doesn't re-render (ids stay whole).
  const attentionIds = useAppStore(useShallow(selectAttention))
  const foldTimes = useMemo(() => {
    const held = attentionIds.flatMap((id) => [...(watched.get(id) ?? [])])
    // Attention no chat claims could be any chat's: then nothing folds.
    const heldChats = new Set(held)
    const unplaced = heldChats.has(null)
    const times = new Map(baseTimes)
    for (const [chatId] of baseTimes) {
      if (unplaced || heldChats.has(chatId)) {
        times.set(chatId, Number.POSITIVE_INFINITY)
      }
    }
    return times
  }, [baseTimes, attentionIds, watched])
  const split = useMemo(() => {
    const shown = olderByBot.get(entryKey)
    // No fresh read, or the owner over or in the list (or not yet sampled on mount): only what was folded
    // before stays folded, and with nothing drawn before, nothing folds.
    const keepFoldedOnly = !fresh || input.held ? (shown ?? new Set<string>()) : null
    return splitOlderBotSidebarChats(views, foldTimes, now, keepFoldedOnly)
  }, [entryKey, fresh, input.held, now, views, foldTimes])
  const olderKey = split.older.map((view) => view.chat.chatId).join('\n')
  useEffect(() => {
    olderByBot.set(entryKey, new Set(olderKey ? olderKey.split('\n') : []))
  }, [entryKey, olderKey])
  return split
}

/** Whether the owner is over or in a list: the pointer over it, or focus inside (portaled menus too,
 *  through React's tree); held until its first layout reads whether a still pointer is already over it.
 *  A blur that focus re-enters in the same task never reads as leaving. */
export function useListHold(): {
  held: boolean
  ref: React.RefObject<HTMLDivElement | null>
  handlers: {
    onPointerEnter: () => void
    onPointerLeave: () => void
    onFocus: () => void
    onBlur: () => void
  }
} {
  const ref = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)
  const [pointerIn, setPointerIn] = useState(false)
  const [focusIn, setFocusIn] = useState(false)
  const inside = useRef(false)
  useLayoutEffect(() => {
    // The wrapper has no box of its own (`contents`), so ask its rows.
    setPointerIn(ref.current?.querySelector(':hover') != null)
    setFocusIn(ref.current?.contains(document.activeElement) ?? false)
    setMounted(true)
  }, [])
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
  return { held: !mounted || pointerIn || focusIn, ref, handlers }
}
