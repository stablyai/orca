// One chat in the Chats tab: one folded row; its chevron shows the workers it started, capped and stepped.
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import StatusIndicator from '@/components/sidebar/workspace-card/surface/StatusIndicator'
import { useTranslate } from '@/i18n/use-translate'
import { openBotHomeTab } from '@/lib/bot-catalog'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import { cn } from '@/lib/class-names'
import { useBotUsageLimitStopIndex } from './use-bot-usage-limit-stops'
import { UsageLimitStopMark, usageLimitStopText } from './BotUsageLimitMark'
import type { Bot } from '../../../../shared/bot-types'
import {
  CHAT_TREE_CAPS,
  chatFoldCounts,
  chatFoldSummary,
  chatRunningCount,
  chatWaitingCount,
  type BotChatTreeChat
} from '../../../../shared/bots/bot-chat-tree'
import {
  CHATS_TAB_FIRST_WORKERS,
  botChatPlace,
  chatsTabWorkers
} from '../../../../shared/bots/bot-chat-tree-view'
import { CONNECTOR_SOURCE_NAMES } from '../../../../shared/connectors/external-conversation-link'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { openAgentSessionHistoryModal } from '../right-sidebar/ai-vault/panel/agent-session-history-modal'
import { BotChatStatusSlot, useBotChatLabel } from './BotChatOriginIcon'
import { BotChatPaging, FOLD_TOGGLE_CLASS, MENU_TAKES_PLACE } from './BotChatRowControls'
import { openBotAutomation } from './bot-automation-open'
import { revealWorkerPane } from '@/lib/open-orchestration-worker'
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { BotChatTreeWorkerRow } from './BotChatTreeWorkerRow'
import { BotChatContextMenu, BotChatMoreButton, botChatHasMenu } from './BotChatRowMenu'
import { openBotSession } from './bot-session-open'

function openChat(bot: Bot, chat: BotChatTreeChat): void {
  const { run } = chat
  if (run) {
    // A terminal run has no chat: its terminal is what opens, else its run record.
    const host = parseExecutionHostId(bot.hostId)
    if (run.worktreeId && run.paneKey) {
      revealWorkerPane(run.worktreeId, run.paneKey, host?.kind === 'runtime' ? host.id : undefined)
    } else {
      openBotAutomation(bot.hostId, run.automationId, run.runId)
    }
  } else if (chat.closed) {
    // A closed chat reads in Session History.
    openAgentSessionHistoryModal({
      workspace: { worktreeId: folderWorkspaceKey(bot.folderWorkspaceId) },
      chatTabId: structuredAgentSessionTabId(chat.chatId),
      initialQuery: '',
      alongside: true
    })
  } else if (chat.origin === 'home') {
    void openBotHomeTab(bot)
  } else {
    openBotSession(bot, chat.chatId)
  }
}

/** A chat row's second line, as the Chats tab shows it (the `@` list's chat rows too). With
 *  `liveAtEnd`, the chat's live state is left to the line's end (`ChatRowLive`), so the preview stays. */
export function BotChatLine({
  bot,
  chat,
  folded,
  liveAtEnd = false
}: {
  bot: Bot
  chat: BotChatTreeChat
  folded: boolean
  liveAtEnd?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const stop = useBotUsageLimitStopIndex().bySession.get(chat.chatId)
  if (liveAtEnd) {
    return <BotChatPreview bot={bot} chat={chat} />
  }
  if (chat.live === 'replying') {
    return <>{t('bots.chats.replying', 'Replying…')}</>
  }
  const place = botChatPlace(chat)
  if (stop && chat.live === 'idle') {
    return <>{[place, usageLimitStopText(t, stop)].filter(Boolean).join(' · ')}</>
  }
  if (chat.live === 'needs-you') {
    return (
      <>
        {place ? `${place} · ` : null}
        <span className="text-foreground">{t('bots.chats.waiting', 'Waiting for you')}</span>
      </>
    )
  }
  const counts = folded ? chatFoldCounts(chat) : null
  if (counts) {
    return <>{chatFoldSummary(t, counts)}</>
  }
  return <BotChatPreview bot={bot} chat={chat} />
}

/** Where the chat is, when it closed, and the last thing said. */
function BotChatPreview({ bot, chat }: { bot: Bot; chat: BotChatTreeChat }): React.JSX.Element {
  const t = useTranslate()
  const closed = chat.closedAt
    ? t('bots.chats.closedOn', 'closed {{date}}', {
        date: uiDateTimeFormat({ month: 'short', day: 'numeric' }).format(chat.closedAt)
      })
    : null
  const preview =
    chat.preview ??
    (chat.origin === 'home'
      ? t('bots.chats.sayHi', 'Say hi to {{name}}', { name: bot.name })
      : null)
  return <>{[botChatPlace(chat), closed, preview].filter(Boolean).join(' · ')}</>
}

/** The preview line's end for the chat itself: replying, waiting for the owner, or stopped on its
 *  usage limit while quiet. */
function ChatRowLive({ chat }: { chat: BotChatTreeChat }): React.JSX.Element | null {
  const t = useTranslate()
  const stop = useBotUsageLimitStopIndex().bySession.get(chat.chatId)
  if (chat.live === 'replying') {
    return <span className={META}>{t('bots.chats.replying', 'Replying…')}</span>
  }
  if (chat.live === 'needs-you') {
    return (
      <span className={cn(META, 'text-foreground')}>
        {t('bots.chats.waiting', 'Waiting for you')}
      </span>
    )
  }
  return stop ? (
    <span className={cn(META, 'text-status-warning-text')}>{usageLimitStopText(t, stop)}</span>
  ) : null
}

const META = 'flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground tabular-nums'

/** The preview line's end while workers wait or run: "N needs you" with its dot and "N running"
 *  with its spinner (their glyphs alone when narrow), and how many stopped on a usage limit. */
function ChatRowWork({ chat }: { chat: BotChatTreeChat }): React.JSX.Element | null {
  const t = useTranslate()
  const waiting = chatWaitingCount(chat)
  const { byWorkspace } = useBotUsageLimitStopIndex()
  // A worker stopped on its limit counts as stopped, not running; one asking the owner still waits.
  const stoppedWorkers = [...chat.running, ...chat.finished].filter(
    (worker) =>
      worker.state !== 'needs-you' && worker.worktreeId && byWorkspace.has(worker.worktreeId)
  )
  const stopped = stoppedWorkers.map((worker) => byWorkspace.get(worker.worktreeId!)!)
  const running =
    chatRunningCount(chat) -
    stoppedWorkers.filter(
      (worker) => chat.running.includes(worker) && worker.state !== 'unreachable'
    ).length
  if (waiting + running + stopped.length > 0) {
    const waitingLabel = t('bots.chats.needsYouCount', '{{count}} needs you', { count: waiting })
    const runningLabel = t('bots.chats.runningCount', '{{count}} running', { count: running })
    return (
      <span className="flex shrink-0 items-center gap-2">
        {stopped.length > 0 ? (
          <span className={cn(META, 'text-status-warning-text')}>
            <UsageLimitStopMark stop={stopped[0]!} />
            <span aria-hidden>{stopped.length}</span>
            <span className="sr-only">
              {t('bots.usageLimit.stoppedCount', '{{count}} stopped', { count: stopped.length })}
            </span>
          </span>
        ) : null}
        {waiting > 0 ? (
          <span className={META}>
            <span
              role="img"
              aria-label={waitingLabel}
              className="block size-[7px] rounded-full bg-agent-question"
            />
            <span aria-hidden className="text-agent-question-text @max-[240px]:hidden">
              {waitingLabel}
            </span>
          </span>
        ) : null}
        {running > 0 ? (
          <span className={META}>
            <StatusIndicator status="working" showTooltip={false} aria-label={runningLabel} />
            <span aria-hidden className="@max-[240px]:hidden">
              {runningLabel}
            </span>
          </span>
        ) : null}
      </span>
    )
  }
  return null
}

export function BotChatTreeGroup({
  bot,
  chat,
  unfolded,
  onFold,
  loadMore
}: {
  bot: Bot
  chat: BotChatTreeChat
  /** The panel's own fold, apart from the sidebar's; null for a search's chat hit, which lists no workers. */
  unfolded: boolean | null
  onFold: (open: boolean) => void
  loadMore: (chatId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const stopIndex = useBotUsageLimitStopIndex()
  const [limit, setLimit] = useState(CHATS_TAB_FIRST_WORKERS)
  const foldable = unfolded !== null && chat.runningTotal + chat.finishedTotal > 0
  const open = foldable && unfolded === true
  const { workers, more, read } = chatsTabWorkers(chat, limit)
  const source =
    chat.origin === 'slack' || chat.origin === 'linear' || chat.origin === 'github'
      ? CONNECTOR_SOURCE_NAMES[chat.origin]
      : null
  // A side chat has no title until its first turn.
  const title = chat.title || t('bots.chats.untitled', 'New chat')
  const chatName = [source, title].filter(Boolean).join(' · ')
  const label = useBotChatLabel(chat, title)
  const toggleFold = (): void => {
    if (!open && read) {
      loadMore(chat.chatId)
    }
    onFold(!open)
  }
  const showMore = (): void => {
    const next = limit + CHAT_TREE_CAPS.step
    if (chatsTabWorkers(chat, next).read) {
      loadMore(chat.chatId)
    }
    setLimit(next)
  }
  // A press only opens the chat, the open one too; the chevron alone folds. A double-click opens once.
  const pressRow = (event: { detail: number }): void => {
    if (event.detail <= 1) {
      openChat(bot, chat)
    }
  }
  return (
    <div className="flex flex-col">
      <BotChatContextMenu bot={bot} chat={chat} onOpen={() => openChat(bot, chat)}>
        <div className="group/bot-chat relative flex w-full min-w-0 items-start gap-1 rounded-md py-1.5 pr-2 pl-2 hover:bg-accent">
          <button
            type="button"
            aria-label={[label, chat.unread ? t('bots.chats.unread', 'Unread') : null]
              .filter(Boolean)
              .join(' · ')}
            className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={pressRow}
            // A held key repeats its click; it must not open the chat again and again.
            onKeyDown={(event) => {
              if (event.repeat) {
                event.preventDefault()
              }
            }}
          />
          {/* A chat with workers: its source icon turns into the fold chevron on hover, and stays one while unfolded. */}
          <span className="relative flex h-5 w-4 shrink-0 items-center justify-center">
            <BotChatStatusSlot
              chat={chat}
              stop={stopIndex.bySession.get(chat.chatId) ?? null}
              className={cn(
                'h-5 w-4',
                // Hidden exactly while the chevron over it shows: on hover, or while it has focus.
                foldable &&
                  'group-hover/bot-chat:invisible group-has-[[data-fold]:focus-visible]/bot-chat:invisible',
                open && 'invisible'
              )}
              iconClassName="size-3.5"
              onClick={pressRow}
            />
            {foldable ? (
              <button
                type="button"
                data-fold=""
                aria-expanded={open}
                aria-label={
                  open
                    ? t('bots.chats.fold', 'Fold {{name}}', { name: title })
                    : t('bots.chats.unfold', 'Unfold {{name}}', { name: title })
                }
                className={cn(
                  'absolute inset-0',
                  FOLD_TOGGLE_CLASS,
                  !open && 'opacity-0 group-hover/bot-chat:opacity-100 focus-visible:opacity-100'
                )}
                onClick={toggleFold}
              >
                <ChevronRight className={cn('size-3.5', open && 'rotate-90')} />
              </button>
            ) : null}
          </span>
          <span className="min-w-0 flex-1 pl-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'min-w-0 truncate text-[13px] font-medium text-foreground',
                  chat.unread && 'font-semibold'
                )}
              >
                {title}
              </span>
              {chat.unseen ? (
                <span className="shrink-0 rounded border border-input px-1 text-[10px] leading-[14px] font-semibold text-foreground">
                  {t('bots.chats.newTag', 'New')}
                </span>
              ) : null}
              <span className="flex-1" />
              {/* The ⋯ takes the time's place on hover, flush to the same edge, so nothing moves. */}
              <span className="group/chat-end relative flex h-5 min-w-6 shrink-0 items-center justify-end">
                {chat.lastActiveAt > 0 ? (
                  <span
                    className={cn(
                      'text-2xs text-muted-foreground tabular-nums',
                      botChatHasMenu(chat) && MENU_TAKES_PLACE
                    )}
                  >
                    {formatShortTimeAgo(chat.lastActiveAt)}
                  </span>
                ) : null}
                <BotChatMoreButton
                  bot={bot}
                  chat={chat}
                  onOpen={() => openChat(bot, chat)}
                  className="absolute top-1/2 right-0 -translate-y-1/2"
                />
              </span>
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                <BotChatLine bot={bot} chat={chat} folded={false} liveAtEnd />
              </span>
              <ChatRowLive chat={chat} />
              <ChatRowWork chat={chat} />
            </span>
          </span>
        </div>
      </BotChatContextMenu>
      {open ? (
        <div className="mb-1 ml-6 flex flex-col @max-[240px]:ml-3.5">
          {workers.map((worker) => (
            <BotChatTreeWorkerRow key={worker.key} bot={bot} worker={worker} chat={chatName} />
          ))}
          <BotChatPaging
            more={
              more > 0
                ? [
                    {
                      label: t('bots.chats.showMoreCount', 'Show {{count}} more', {
                        count: Math.min(more, CHAT_TREE_CAPS.step)
                      }),
                      onClick: showMore
                    }
                  ]
                : []
            }
            onFewer={
              limit > CHATS_TAB_FIRST_WORKERS ? () => setLimit(CHATS_TAB_FIRST_WORKERS) : null
            }
            className="py-1 pl-5 text-xs"
          />
        </div>
      ) : null}
    </div>
  )
}
