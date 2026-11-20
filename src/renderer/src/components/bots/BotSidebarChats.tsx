import React, { useEffect, useMemo } from 'react'
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
import { botSidebarListedChats } from '../../../../shared/bots/bot-sidebar-chat-groups'
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
import { openBotSession } from './bot-session-open'
import { botSidebarEntryKey } from './bot-sidebar-entry-keys'
import { useBotsRevealRequest } from './bots-sidebar-reveal-context'

/** The bot's open chat tabs in the panel's order, each with the workspaces its workers have, nested by indent. */
export function BotSidebarChats({
  bot,
  tree,
  workspaces,
  lineageChildrenByParentIdentity,
  activeLine,
  steps,
  onStep,
  onOpen
}: {
  bot: Bot
  tree: BotChatTree
  /** The bot's lines in Smart order, sleeping ones already left out. */
  workspaces: readonly Worktree[]
  lineageChildrenByParentIdentity: ReadonlyMap<string, Worktree[]>
  activeLine: Worktree | undefined
  steps: Readonly<Record<string, number>>
  onStep: (chatId: string, steps: number) => void
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

  return (
    <>
      {view.chats.map((chatView) => (
        <BotSidebarChat
          key={chatView.chat.chatId}
          bot={bot}
          view={chatView}
          notes={notes}
          lineageChildrenByParentIdentity={lineageChildrenByParentIdentity}
          onStep={(next) => onStep(chatView.chat.chatId, next)}
          onOpen={onOpen}
        />
      ))}
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
    </>
  )
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
  notes,
  lineageChildrenByParentIdentity,
  onStep,
  onOpen
}: {
  bot: Bot
  view: BotSidebarChatView<Worktree>
  notes: ReadonlyMap<string, string>
  lineageChildrenByParentIdentity: ReadonlyMap<string, Worktree[]>
  onStep: (steps: number) => void
  onOpen: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { chat, foldable, open, lines, paging, steps } = view
  const { active, toggle } = useBotChatPress(bot, chat.chatId)
  const title = chatTitle(t, chat)
  const label = useBotChatLabel(chat, title)
  const trailing = trailingText(t, view.trailing)
  // A press only switches to the chat; only the chevron shows or hides its workers.
  const pressRow = (event: { detail: number; repeat?: boolean }): void => {
    if (event.detail > 1 || event.repeat) {
      return
    }
    if (chat.origin === 'home') {
      void openBotHomeTab(bot)
    } else {
      openBotSession(bot, chat.chatId)
    }
  }

  return (
    <div className="flex flex-col gap-1">
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
          className="max-w-[60%]"
        />
      </div>
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
