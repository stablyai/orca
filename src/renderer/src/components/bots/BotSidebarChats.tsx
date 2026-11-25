import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AttachedWorktreeCards } from '@/components/sidebar/AttachedWorktreeCards'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { openBotHomeTab } from '@/lib/bot-catalog'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import {
  botChatFoldKey,
  chatFoldSummary,
  type BotChatTreeChat
} from '../../../../shared/bots/bot-chat-tree'
import {
  botLiveWorkspaceIds,
  botSidebarListedChats
} from '../../../../shared/bots/bot-sidebar-chat-groups'
import {
  botSidebarWorkerPagingLabel,
  buildBotSidebarTree,
  type BotSidebarChatTrailing,
  type BotSidebarChatView
} from '../../../../shared/bots/bot-sidebar-tree'
import type { Worktree } from '../../../../shared/worktree/types'
import { BotChatStatusSlot, useBotChatLabel } from './BotChatOriginIcon'
import { BotChatPaging, BotChatRowEnd, useBotChatPress } from './BotChatRowControls'
import type { BotChatTree } from './use-bot-chat-tree'
import { BotChatContextMenu, BotChatMoreButton, botChatHasMenu } from './BotChatRowMenu'
import { openBotSession } from './bot-session-open'
import { botSidebarEntryKey } from './bot-sidebar-entry-keys'
import { useBotsRevealRequest } from './bots-sidebar-reveal-context'
import { BotSidebarOlderToggle } from './BotSidebarOlderChats'
import {
  useBotHomeFrontTab,
  useBotSidebarOlderChats,
  useListHold
} from './use-bot-sidebar-older-chats'

/** Not a chat id: chat ids are session ids. */
const OLDER_TOGGLE_KEY = '\u0000older-toggle'

/** The bot's open chat tabs in the panel's order, each with the workspaces its workers have, nested by
 *  indent; settled ones a day old fold under one "Show N older" link. */
export function BotSidebarChats({
  bot,
  tree,
  workspaces,
  allWorkspaces,
  lineageChildrenByParentIdentity,
  activeLine,
  steps,
  onStep,
  showOlder,
  onToggleOlder,
  onOpen
}: {
  bot: Bot
  tree: BotChatTree
  /** The bot's lines in Smart order, sleeping ones already left out. */
  workspaces: readonly Worktree[]
  /** Every line, sleeping ones too: attention under a hidden line still keeps its chat listed. */
  allWorkspaces: readonly Worktree[]
  lineageChildrenByParentIdentity: ReadonlyMap<string, Worktree[]>
  activeLine: Worktree | undefined
  steps: Readonly<Record<string, number>>
  onStep: (chatId: string, steps: number) => void
  showOlder: boolean
  onToggleOlder: () => void
  onOpen: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { chats, workspaceChats } = tree
  // Only this bot's chats' folds, so a fold anywhere else re-renders nothing here.
  // Only the chats it lists, keyed once per chat list, not on every store write the selector runs for.
  const listed = useMemo(() => botSidebarListedChats(chats), [chats])
  const foldKeys = useMemo(
    () => listed.map((chat) => botChatFoldKey(bot.hostId, bot.id, chat.chatId)),
    [listed, bot.hostId, bot.id]
  )
  const folds = useAppStore(useShallow((s) => foldKeys.map((key) => s.botChatFolds[key])))
  const view = useMemo(() => {
    const foldById = new Map(listed.map((chat, index) => [chat.chatId, folds[index]]))
    return buildBotSidebarTree({
      chats,
      workspaces,
      workspaceChats,
      foldOf: (chatId) => foldById.get(chatId),
      stepsOf: (chatId) => steps[chatId] ?? 0,
      activeLineId: activeLine?.id ?? null
    })
  }, [chats, listed, workspaceChats, workspaces, folds, steps, activeLine])
  // A reveal of a worker line under a folded chat opens that chat, once per request.
  const reveal = useBotsRevealRequest(botSidebarEntryKey(bot))
  const revealWorker = reveal?.target.hostDown ? undefined : reveal?.target.worker
  const revealLineId = revealWorker ? (revealWorker.ancestors[0]?.id ?? revealWorker.id) : null
  const revealNonce = reveal?.nonce ?? null
  const setBotChatFold = useAppStore((s) => s.setBotChatFold)
  const foldedHolder = revealLineId
    ? view.chats.find(
        (chatView) =>
          chatView.foldable &&
          !chatView.open &&
          chatView.lines.some((line) => line.id === revealLineId)
      )?.chat.chatId
    : undefined
  useEffect(() => {
    if (revealNonce !== null && foldedHolder) {
      setBotChatFold(bot.hostId, bot.id, foldedHolder, 'open')
    }
  }, [revealNonce, foldedHolder, setBotChatFold, bot.hostId, bot.id])
  const { held, ref: holdRef, handlers: holdHandlers } = useListHold()
  const front = useBotHomeFrontTab(bot.folderWorkspaceId)
  // The older chat whose row (or portaled menu, through React's tree) holds focus, so Hide can take
  // focus first; checked against the chats listed as older now, so a row that lifted out never counts.
  const focusedOlderChat = useRef<string | null>(null)
  const olderChatIds = useRef<ReadonlySet<string>>(new Set())
  const setOlderFocused = useCallback((chatId: string | null) => {
    focusedOlderChat.current = chatId
  }, [])
  const liveLineIds = useMemo(() => botLiveWorkspaceIds(chats), [chats])
  const revealHeld = useMemo(
    () =>
      reveal && !reveal.target.hostDown
        ? {
            chatId: reveal.target.chatId,
            lineIds: revealWorker
              ? [revealWorker.id, ...revealWorker.ancestors.map((line) => line.id)]
              : []
          }
        : null,
    [reveal, revealWorker]
  )
  const { recent, older } = useBotSidebarOlderChats({
    bot,
    entryKey: botSidebarEntryKey(bot),
    views: view.chats,
    workspaces: allWorkspaces,
    workspaceChats,
    lineageChildrenByParentIdentity,
    liveLineIds,
    activeLineId: activeLine?.id ?? null,
    reveal: revealHeld,
    front,
    fresh: tree.state === 'ready' && tree.landed && !tree.refreshFailed && !tree.changeUnread,
    held
  })
  useLayoutEffect(() => {
    const ids = new Set(older.map((chatView) => chatView.chat.chatId))
    // A chat that leaves the older list no longer counts as a focused older row, even if it folds again.
    if (focusedOlderChat.current !== null && !ids.has(focusedOlderChat.current)) {
      focusedOlderChat.current = null
    }
    olderChatIds.current = ids
  }, [older])
  // Focus is in one of this list's older rows: its own DOM, or a portal its row opened while it is still
  // listed as older. Another bot's list, an outside input or a lifted row never counts.
  const olderFocused = useCallback((): boolean => {
    const active = document.activeElement
    if (!active || active === document.body) {
      return false
    }
    const owned = [
      ...(holdRef.current?.querySelectorAll('[data-bot-sidebar-older-chat]') ?? [])
    ].some((row) => row.contains(active))
    const chatId = focusedOlderChat.current
    return owned || (chatId !== null && olderChatIds.current.has(chatId))
  }, [holdRef])
  // The toggle unmounting while it had focus (fewer than two left to fold) hands focus to the last chat
  // row; focus anywhere else is left alone.
  const toggleLeftWithFocus = useRef(false)
  const markToggleLeftWithFocus = useCallback(() => {
    toggleLeftWithFocus.current = true
  }, [])
  useLayoutEffect(() => {
    if (!toggleLeftWithFocus.current) {
      return
    }
    toggleLeftWithFocus.current = false
    if (document.activeElement === null || document.activeElement === document.body) {
      const rows = [
        ...(holdRef.current?.querySelectorAll<HTMLElement>('[data-bot-sidebar-chat]') ?? [])
      ]
      rows.at(-1)?.focus()
    }
  }, [older.length, holdRef])
  const notes = useMemo(() => {
    const labels = new Map<string, string>()
    for (const [worktreeId, note] of view.notes) {
      labels.set(
        worktreeId,
        note === 'handed-over'
          ? t('bots.chats.handedOverInline', 'handed over')
          : t('bots.chats.fromClosedChatInline', 'from closed chat')
      )
    }
    return labels
  }, [view.notes, t])

  const chatRow = (chatView: BotSidebarChatView<Worktree>, folded: boolean): React.JSX.Element => (
    <BotSidebarChat
      key={chatView.chat.chatId}
      bot={bot}
      // Listed under "Hide older", a chat is its row alone: its workspace cards (and their reads) stay
      // unmounted until it is opened or lifts back up.
      view={folded ? olderRowView(chatView) : chatView}
      folded={folded}
      onOlderFocus={setOlderFocused}
      notes={notes}
      lineageChildrenByParentIdentity={lineageChildrenByParentIdentity}
      onStep={(next) => onStep(chatView.chat.chatId, next)}
      onOpen={onOpen}
    />
  )
  // One keyed list, toggle included, so a chat moving between recent and older keeps its row (focus,
  // open menu) instead of mounting again under another parent.
  const rows = [
    ...recent.map((chatView) => chatRow(chatView, false)),
    ...(older.length > 0
      ? [
          <BotSidebarOlderToggle
            key={OLDER_TOGGLE_KEY}
            count={older.length}
            open={showOlder}
            onToggle={onToggleOlder}
            onRemovedWithFocus={markToggleLeftWithFocus}
            olderFocused={olderFocused}
          />
        ]
      : []),
    ...(older.length > 0 && showOlder ? older.map((chatView) => chatRow(chatView, true)) : [])
  ]

  return (
    // `contents`, so the rows stay the parent's flex children; it only watches the pointer and focus.
    <div ref={holdRef} className="contents" {...holdHandlers}>
      {rows}
      {view.stray.length > 0 ? (
        <AttachedWorktreeCards
          roots={view.stray}
          lineageChildrenByParentIdentity={lineageChildrenByParentIdentity}
          compactLine
          lineOwnerHostId={bot.hostId}
          lineNotes={notes}
          onOpen={onOpen}
        />
      ) : null}
    </div>
  )
}

/** An older chat's row with nothing under it: no fold, no workspace lines, its time at the edge. */
function olderRowView(chatView: BotSidebarChatView<Worktree>): BotSidebarChatView<Worktree> {
  const at = chatView.chat.lastActiveAt
  return {
    ...chatView,
    foldable: false,
    open: false,
    lines: [],
    paging: null,
    trailing: at > 0 ? { kind: 'time', at } : null
  }
}

function chatTitle(t: ReturnType<typeof useTranslate>, chat: BotChatTreeChat): string {
  return chat.origin === 'home' ? t('bots.chats.home', 'Home Chat') : chat.title
}

function trailingText(t: Translate, trailing: BotSidebarChatTrailing | null): string | null {
  if (!trailing) {
    return null
  }
  return trailing.kind === 'summary'
    ? chatFoldSummary(t, trailing.counts)
    : formatShortTimeAgo(trailing.at)
}

function BotSidebarChat({
  bot,
  view,
  folded,
  onOlderFocus,
  notes,
  lineageChildrenByParentIdentity,
  onStep,
  onOpen
}: {
  bot: Bot
  view: BotSidebarChatView<Worktree>
  /** Listed under "Hide older". */
  folded: boolean
  /** The row's chat id when focus enters a listed older row (or its menu), null when it leaves. */
  onOlderFocus: (chatId: string | null) => void
  notes: ReadonlyMap<string, string>
  lineageChildrenByParentIdentity: ReadonlyMap<string, Worktree[]>
  onStep: (steps: number) => void
  onOpen: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { chat, foldable, open, lines, paging, steps } = view
  const { active, toggle, highlight } = useBotChatPress(bot, chat.chatId)
  const title = chatTitle(t, chat)
  const label = useBotChatLabel(chat, title)
  const trailing = trailingText(t, view.trailing)
  // A press only switches to the chat; only the chevron shows or hides its workers. Pressed while
  // its chat is already in front, it flashes that chat's pane so the press visibly lands.
  const pressRow = (event: { detail: number; repeat?: boolean }): void => {
    if (event.detail > 1 || event.repeat) {
      return
    }
    if (active) {
      highlight()
    }
    if (chat.origin === 'home') {
      void openBotHomeTab(bot)
    } else {
      openBotSession(bot, chat.chatId)
    }
  }

  return (
    <div
      className="flex flex-col gap-1"
      data-bot-sidebar-older-chat={folded ? '' : undefined}
      onFocus={folded ? () => onOlderFocus(chat.chatId) : undefined}
      onBlur={folded ? () => onOlderFocus(null) : undefined}
    >
      <BotChatContextMenu bot={bot} chat={chat} onOpen={() => pressRow({ detail: 1 })}>
        {/* Its label names the slot's kind and state; pr-0.5 puts the chevron on the bot chevron's edge. */}
        <div
          role="button"
          data-bot-sidebar-chat={chat.chatId}
          aria-label={[label, trailing].filter(Boolean).join(' · ')}
          // The chat whose tab is in front reads as the current row, as the open workspace's does.
          aria-current={active ? 'true' : undefined}
          tabIndex={0}
          aria-expanded={foldable ? open : undefined}
          className={cn(
            'group/bot-chat flex h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-0.5 pl-1 text-xs text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
            active && 'bg-sidebar-accent'
          )}
          onClick={pressRow}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              pressRow(event)
            }
          }}
        >
          <BotChatStatusSlot chat={chat} />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-foreground',
              (chat.unread || active) && 'font-semibold'
            )}
          >
            {title}
          </span>
          <BotChatRowEnd
            text={trailing}
            fold={foldable ? { open, name: title, onToggle: () => toggle(open) } : null}
            menu={
              botChatHasMenu(chat) ? (
                <BotChatMoreButton bot={bot} chat={chat} onOpen={() => pressRow({ detail: 1 })} />
              ) : null
            }
            className="max-w-[60%]"
          />
        </div>
      </BotChatContextMenu>
      {open ? (
        <div className="ml-3 flex flex-col gap-1">
          <AttachedWorktreeCards
            roots={lines}
            lineageChildrenByParentIdentity={lineageChildrenByParentIdentity}
            compactLine
            lineOwnerHostId={bot.hostId}
            lineNotes={notes}
            onOpen={onOpen}
          />
          <BotChatPaging
            more={
              paging
                ? [
                    {
                      label: botSidebarWorkerPagingLabel(t, paging),
                      onClick: () => onStep(steps + 1)
                    }
                  ]
                : []
            }
            onFewer={steps > 0 ? () => onStep(0) : null}
            className="pr-2 pb-1 pl-1"
          />
        </div>
      ) : null}
    </div>
  )
}
