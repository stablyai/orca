// Item changes in a bot chat: the same quiet one-line row for every change, item names as chips that
// open the item in the Items tab (a one-item line opens it from anywhere on the line); the owner's comment is their own message, headed by the item's chip. A run
// of the owner's quick changes to one item folds into one line that opens into each change; a long line
// clamps to two lines, and a bulk line shows a few chips then "+N more".
import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, ListTodo, MessageSquare } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import { BotItemStatusIcon } from '@/components/bots/items/BotItemStatusIcon'
import { botItemStatusName } from '@/components/bots/items/bot-item-status-name'
import { openBotItem } from '@/components/bots/items/bot-item-open'
import { BotItemCommentImages } from '@/components/bots/items/BotItemCommentImages'
import { findBotByWorkspace, useBotForWorkspace } from '@/components/bots/bot-workspace'
import { openBotSession } from '@/components/bots/bot-session-open'
import { readBots } from '@/lib/bot-catalog'
import type { BotItemNoteItem, BotItemNoteView } from '../../../../../shared/bots/bot-item-note'
import { stripSentImagePromptMarkers } from '../../../../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { NativeChatMessageTimestamp } from '../messages/rows/NativeChatMessageTimestamp'
import { NativeChatUserBubble } from '../messages/rows/NativeChatUserBubble'
import { useBotItemChipPreview } from './bot-item-chip-preview'
import {
  botItemNoteLines,
  botItemNoteRunLine,
  type BotItemNoteLine,
  type BotItemNoteLineChat
} from '../../../../../shared/bots/bot-item-note-lines'

/** The chat's bot is the one whose home it is in. */
function openChipItem(uid: string): void {
  const bot = findBotByWorkspace(readBots(), useAppStore.getState().activeWorktreeId)
  if (bot) {
    openBotItem(bot, uid)
  }
}

function ChipPreview({ item }: { item: BotItemNoteItem }): React.JSX.Element {
  const t = useTranslate()
  const bot = useBotForWorkspace(useAppStore((state) => state.activeWorktreeId))
  const live = useBotItemChipPreview(bot, item.uid)
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium">{live?.title ?? item.title}</span>
      {live ? <span>{botItemStatusName(live.status, t)}</span> : null}
      <span className="opacity-70">
        {t('bots.items.chat.openInItems', 'Click to open in Items')}
      </span>
    </span>
  )
}

function ItemChip({ item }: { item: BotItemNoteItem }): React.JSX.Element {
  const t = useTranslate()
  // The preview, and its live read, exist only while the tooltip is open.
  const [open, setOpen] = useState(false)
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          // The glyph alone shows the status, so the chip says it.
          aria-label={t('bots.items.chat.chipLabel', '{{title}}, {{status}}', {
            title: item.title,
            status: botItemStatusName(item.status, t)
          })}
          className="inline-flex max-w-[16rem] items-center gap-1 rounded-md bg-chat-foreground/5 px-1.5 align-middle text-xs leading-5 text-chat-foreground hover:bg-chat-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => openChipItem(item.uid)}
        >
          <BotItemStatusIcon status={item.status} />
          <span className="min-w-0 truncate">{item.title}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {open ? <ChipPreview item={item} /> : null}
      </TooltipContent>
    </Tooltip>
  )
}

/** The chat that made a change, opening that chat. */
function ChatChip({ chat }: { chat: BotItemNoteLineChat }): React.JSX.Element {
  const t = useTranslate()
  return (
    <button
      type="button"
      aria-label={t('bots.items.chat.openChat', 'Open {{chat}}', { chat: chat.name })}
      className="inline-flex max-w-[16rem] items-center gap-1 rounded-md bg-chat-foreground/5 px-1.5 align-middle text-xs leading-5 text-chat-foreground hover:bg-chat-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => {
        const bot = findBotByWorkspace(readBots(), useAppStore.getState().activeWorktreeId)
        if (bot) {
          // Home Chat by its live session, which a /clear moved past the chat id.
          openBotSession(bot, (chat.home && bot.chatSessionId) || chat.chatId)
        }
      }}
    >
      <MessageSquare className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{chat.name}</span>
    </button>
  )
}

/** Chips a bulk line shows before "+N more". */
const CHIPS_SHOWN = 3

function QuietLine({
  line,
  at,
  open,
  onToggle
}: {
  line: BotItemNoteLine & { kind: 'line' }
  at?: number
  /** A folded run's own disclosure; without one, a long line clamps and opens itself. */
  open?: boolean
  onToggle?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)
  const [allChips, setAllChips] = useState(false)
  const [clamped, setClamped] = useState(false)
  const text = useRef<HTMLSpanElement | null>(null)
  useLayoutEffect(() => {
    const node = text.current
    if (node && !expanded && !onToggle) {
      setClamped(node.scrollHeight > node.clientHeight + 1)
    }
  }, [line, expanded, onToggle, allChips])
  const chips = allChips ? line.items : line.items.slice(0, CHIPS_SHOWN)
  const hiddenChips = line.items.length - chips.length
  const toggle = onToggle ?? (clamped || expanded ? () => setExpanded(!expanded) : undefined)
  const isOpen = onToggle ? open : expanded
  // A one-item line opens its item anywhere on it; the chip stays the keyboard target.
  const opens = !onToggle && line.items.length === 1 ? line.items[0]!.uid : undefined
  return (
    <div
      className={cn(
        'group/item-note @container flex min-h-6 items-start gap-1.5 font-sans text-sm leading-relaxed text-chat-foreground-faint',
        opens && 'cursor-pointer'
      )}
      onClick={
        opens
          ? (event) => {
              if (!(event.target instanceof Element && event.target.closest('button'))) {
                openChipItem(opens)
              }
            }
          : undefined
      }
    >
      <ListTodo className="mt-[5px] size-3.5 shrink-0" aria-hidden />
      <span ref={text} className={cn('min-w-0 flex-1', !onToggle && !expanded && 'line-clamp-2')}>
        {line.lead}
        {line.chat ? (
          <>
            {line.lead ? ' ' : null}
            <ChatChip chat={line.chat} />
            {line.chat.after ? ` ${line.chat.after}` : null}
          </>
        ) : null}
        {chips.map((item, index) => (
          <span key={item.uid}>
            {line.lead || line.chat || index > 0 ? ' ' : null}
            <ItemChip item={item} />
          </span>
        ))}
        {hiddenChips > 0 ? (
          <>
            {' '}
            <button
              type="button"
              className="text-xs text-chat-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setAllChips(true)}
            >
              {t('bots.items.chat.moreItems', '+{{count}} more', { count: hiddenChips })}
            </button>
          </>
        ) : null}
        {line.tail ? ` ${line.tail}` : null}
        {line.detail ? <span className="text-chat-foreground">: {line.detail}</span> : null}
      </span>
      {toggle ? (
        <button
          type="button"
          aria-expanded={isOpen}
          aria-label={
            isOpen
              ? t('bots.items.chat.showLess', 'Show less')
              : t('bots.items.chat.showMore', 'Show more')
          }
          onClick={toggle}
          className="mt-[3px] rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden
            className={cn('size-3.5 transition-transform', isOpen && 'rotate-90')}
          />
        </button>
      ) : null}
      {at !== undefined ? (
        <span className="mt-[3px] hidden shrink-0 text-xs @xs:inline">
          <NativeChatMessageTimestamp timestamp={at} />
        </span>
      ) : null}
    </div>
  )
}

function CommentRow({ line }: { line: BotItemNoteLine & { kind: 'comment' } }) {
  const text = stripSentImagePromptMarkers(line.text, line.images?.length ?? 0)
  return (
    <div className="flex flex-col items-end gap-1">
      {line.images ? <BotItemCommentImages images={line.images} /> : null}
      {/* The item heads the bubble, as on the phone. */}
      <NativeChatUserBubble className="flex flex-col items-start gap-1.5">
        <ItemChip item={line.item} />
        {text.trim() ? <div className="whitespace-pre-wrap">{text}</div> : null}
      </NativeChatUserBubble>
    </div>
  )
}

function Lines({ note, at }: { note: BotItemNoteView; at?: number }): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {botItemNoteLines(note, t).map((line) =>
        line.kind === 'comment' ? (
          <CommentRow key={`comment:${line.item.uid}`} line={line} />
        ) : (
          <QuietLine key={`line:${line.items[0]!.uid}`} line={line} at={at} />
        )
      )}
    </>
  )
}

export function NativeChatBotItemNoteRow({
  note,
  timestamp
}: {
  note: BotItemNoteView
  timestamp?: number
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  if (!note.run) {
    return (
      <div className="flex flex-col gap-1">
        <Lines note={note} at={note.at ?? timestamp} />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <QuietLine
        line={botItemNoteRunLine(note.run, t)}
        at={timestamp}
        open={open}
        onToggle={() => setOpen(!open)}
      />
      {open ? (
        <div className="flex flex-col gap-0.5 pl-5">
          {note.run.map((change) => (
            <Lines key={change.noteId} note={change} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
