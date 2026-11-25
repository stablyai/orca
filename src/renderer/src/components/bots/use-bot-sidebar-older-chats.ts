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
import type { BotSidebarChatView } from '../../../../shared/bots/bot-sidebar-tree'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import { useBotWorkerWorkspaceStatuses } from './use-bot-worker-statuses'

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

/** Worker states that keep a workspace's chat listed, as this client sees them before the host says. */
const ATTENTION = new Set(['permission', 'working', 'monitoring'])

/** A chat tab in the bot's home counts for the bot only when it is the bot host's, or names no host. */
export function tabOfBotHost(tab: Tab, hostId: string): boolean {
  return (
    tab.contentType === 'agent-session' && (!tab.executionHostId || tab.executionHostId === hostId)
  )
}

export function useBotSidebarOlderChats(input: {
  bot: Pick<Bot, 'hostId' | 'folderWorkspaceId'>
  entryKey: string
  views: readonly BotSidebarChatView<Worktree>[]
  workspaces: readonly Worktree[]
  workspaceChats: Readonly<Record<string, string>>
  lineageChildrenByParentIdentity: ReadonlyMap<string, Worktree[]>
  /** Host-side live workspaces (`botLiveWorkspaceIds`). */
  liveLineIds: ReadonlySet<string>
  activeLineId: string | null
  reveal: { chatId?: string; lineIds: readonly string[] } | null
  /** A read landed since this list opened, and its last refresh did not fail: only then does anything new fold. */
  fresh: boolean
  /** The owner is over or in the list (a menu or inline rename included), or it is still mounting. */
  held: boolean
}): OlderBotSidebarChats<Worktree> {
  const { bot, entryKey, views, workspaces, lineageChildrenByParentIdentity, fresh } = input
  const homeKey = useMemo(() => folderWorkspaceKey(bot.folderWorkspaceId), [bot.folderWorkspaceId])
  const homeTabs = useAppStore((s) => s.unifiedTabsByWorktree[homeKey])
  const frontSessionId = useAppStore((s) => {
    if ((s.activeWorkspaceKey ?? s.activeWorktreeId) !== homeKey) {
      return null
    }
    const tab = selectFrontTab(s)
    return tab && tabOfBotHost(tab, bot.hostId) ? tab.entityId : null
  })
  const childrenOf = useCallback(
    (line: Worktree) => lineageChildrenByParentIdentity.get(getWorktreeHostIdentity(line)) ?? [],
    [lineageChildrenByParentIdentity]
  )
  // Every line and its descendants, so a worker waiting on the owner deep in a quiet chat's tree holds it.
  const allLineIds = useMemo(() => {
    const seen = new Set<string>()
    const ids = new Set<string>()
    const walk = (line: Worktree): void => {
      const identity = getWorktreeHostIdentity(line)
      if (!seen.has(identity)) {
        seen.add(identity)
        ids.add(line.id)
        childrenOf(line).forEach(walk)
      }
    }
    workspaces.forEach(walk)
    return [...ids]
  }, [workspaces, childrenOf])
  const statuses = useBotWorkerWorkspaceStatuses(allLineIds)
  const foldTimes = useMemo(() => {
    const focusedAt = new Map<string, number>()
    for (const tab of homeTabs ?? []) {
      if (tabOfBotHost(tab, bot.hostId) && tab.lastFocusedAt !== undefined) {
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
    return botSidebarChatFoldTimes(
      views.map((view) => view.chat),
      {
        focusedAt,
        heldSessionIds: new Set(
          [frontSessionId, input.reveal?.chatId].filter((id): id is string => Boolean(id))
        ),
        heldLineIds,
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
    statuses,
    input.liveLineIds,
    input.activeLineId,
    input.reveal,
    frontSessionId,
    views,
    workspaces,
    input.workspaceChats,
    childrenOf
  ])
  // The clock only counts how many fold times have passed, so a tick re-renders nothing until one does.
  const dueTimes = useMemo(
    () => [...foldTimes.values()].filter(Number.isFinite).sort((a, b) => a - b),
    [foldTimes]
  )
  const countDue = useCallback(
    (clock: number) => {
      // A clock nobody watched for a while reads stale on its first draw; the wall clock never does.
      const now = Math.max(clock, Date.now())
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
  const dueCount = useNowSnapshot(OLDER_CHATS_CLOCK_MS, countDue)
  const split = useMemo(() => {
    const shown = olderByBot.get(entryKey)
    const keepFoldedOnly = !fresh
      ? (shown ?? new Set<string>())
      : input.held
        ? (shown ?? null)
        : null
    const now = dueCount === 0 ? Number.NEGATIVE_INFINITY : dueTimes[dueCount - 1]!
    return splitOlderBotSidebarChats(views, foldTimes, now, keepFoldedOnly)
  }, [entryKey, fresh, input.held, dueCount, dueTimes, views, foldTimes])
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
