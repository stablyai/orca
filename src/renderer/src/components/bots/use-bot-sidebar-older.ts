// Splits a bot's sidebar chat rows into the ones shown and the settled ones a day untouched, folded
// under "Show N older"; and whether this window shows the older ones now. Presentation only.
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useNow } from '@/lib/window-activity/use-now'
import { selectFrontTab } from '@/store/slices/tabs/active-tab-selection'
import type { Bot } from '../../../../shared/bot-types'
import { botChatFoldKey, type BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import {
  BOT_SIDEBAR_OLDER_FOLD_ID,
  splitOlderBotSidebarChats
} from '../../../../shared/bots/bot-sidebar-older-chats'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'

/** Coarse on purpose: a row a day untouched may fold up to this late. */
const OLDER_CLOCK_MS = 5 * 60_000

type View = { chat: BotChatTreeChat; open: boolean; lines: readonly { id: string }[] }

/** Handlers for the element holding the chat rows: while the pointer is over it or focus is inside,
 *  no shown row moves into the fold. */
export type BotSidebarOlderHold = {
  onPointerEnter: () => void
  onPointerLeave: () => void
  onFocus: () => void
  onBlur: (event: React.FocusEvent<HTMLElement>) => void
}

export function useBotSidebarOlder<V extends View>(
  bot: Pick<Bot, 'hostId' | 'id' | 'folderWorkspaceId'>,
  views: readonly V[],
  activeLineId: string | null
): {
  recent: V[]
  older: V[]
  showOlder: boolean
  toggleOlder: () => void
  hold: BotSidebarOlderHold
} {
  const [pointerIn, setPointerIn] = useState(false)
  const [focusIn, setFocusIn] = useState(false)
  const interacting = pointerIn || focusIn
  // The rows shown last render: held where they are while someone is over or in the list.
  const shown = useRef<ReadonlySet<string>>(new Set())
  const homeKey = useMemo(() => folderWorkspaceKey(bot.folderWorkspaceId), [bot.folderWorkspaceId])
  const now = useNow(OLDER_CLOCK_MS)
  // Each row's session ids (its chat, and the session a /clear moved it to), the ones its tab may carry.
  const sessionIds = useMemo(
    () =>
      views.map(({ chat }) =>
        chat.liveSessionId ? [chat.chatId, chat.liveSessionId] : [chat.chatId]
      ),
    [views]
  )
  const frontSessionId = useAppStore((s) => {
    if ((s.activeWorkspaceKey ?? s.activeWorktreeId) !== homeKey) {
      return null
    }
    const tab = selectFrontTab(s)
    return tab?.contentType === 'agent-session' ? tab.entityId : null
  })
  // One number per row, so a focus elsewhere re-renders nothing here.
  const focusTimes = useAppStore(
    useShallow((s) => {
      const tabs = s.unifiedTabsByWorktree[homeKey] ?? []
      return sessionIds.map((ids) =>
        tabs.reduce(
          (latest, tab) =>
            tab.contentType === 'agent-session' && ids.includes(tab.entityId)
              ? Math.max(latest, tab.lastFocusedAt ?? 0)
              : latest,
          0
        )
      )
    })
  )
  const foldKey = botChatFoldKey(bot.hostId, bot.id, BOT_SIDEBAR_OLDER_FOLD_ID)
  const showOlder = useAppStore((s) => s.botChatFolds[foldKey] === 'open')
  const setBotChatFold = useAppStore((s) => s.setBotChatFold)
  const split = useMemo(() => {
    const focusedAt = new Map(
      views.map((view, index) => [view.chat.chatId, focusTimes[index] || undefined])
    )
    const front = frontSessionId
      ? (views.find((view, index) => sessionIds[index].includes(frontSessionId))?.chat.chatId ??
        null)
      : null
    return splitOlderBotSidebarChats(
      views,
      {
        now,
        frontChatId: front,
        focusedAt: (chatId) => focusedAt.get(chatId),
        openChatIds: new Set(views.flatMap((view) => (view.open ? [view.chat.chatId] : []))),
        activeLineChatIds: new Set(
          activeLineId
            ? views.flatMap((view) =>
                view.lines.some((line) => line.id === activeLineId) ? [view.chat.chatId] : []
              )
            : []
        )
      },
      interacting ? shown.current : undefined
    )
  }, [views, focusTimes, frontSessionId, sessionIds, now, activeLineId, interacting])
  useEffect(() => {
    shown.current = new Set(split.recent.map((view) => view.chat.chatId))
  }, [split])
  return {
    ...split,
    showOlder,
    toggleOlder: () =>
      setBotChatFold(bot.hostId, bot.id, BOT_SIDEBAR_OLDER_FOLD_ID, showOlder ? 'folded' : 'open'),
    hold: {
      onPointerEnter: () => setPointerIn(true),
      onPointerLeave: () => setPointerIn(false),
      onFocus: () => setFocusIn(true),
      onBlur: (event) => {
        const next = event.relatedTarget
        if (!(next instanceof Node && event.currentTarget.contains(next))) {
          setFocusIn(false)
        }
      }
    }
  }
}
