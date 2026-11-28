// Item changes in a bot chat: the shared status row for every change, item names as chips that open
// the item in the Items tab (a one-item line opens it from anywhere on the line); the owner's comment
// is their own message, headed by the item's chip. A run of the owner's quick changes to one item
// folds into one row that opens into each change; a line stays on one line (chips and a worker's name
// cut short, a cut-short note opens whole), and a bulk line shows a few chips then "+N more".
import { useEffect, useRef, useState } from 'react'
import { ListTodo, MessageSquare } from 'lucide-react'
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
import { NativeChatEventRow } from '../messages/events/NativeChatEventRow'
import {
  NATIVE_CHAT_INLINE_CHIP,
  NATIVE_CHAT_ROW_SHARE
} from '../messages/events/native-chat-inline-chip'
import { NativeChatUserBubble } from '../messages/rows/NativeChatUserBubble'
import { NativeChatUserMessageBody } from '../messages/rows/NativeChatUserMessageBody'
import { useBotItemChipPreview } from './bot-item-chip-preview'
import {
  botItemNoteLines,
  botItemNoteRunLine,
  type BotItemNoteLine,
  type BotItemNoteLineChat,
  type BotItemNoteLineLink
} from '../../../../../shared/bots/bot-item-note-lines'
import type { AgentMessageSender } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import { SenderChip } from '../messages/agent-senders/NativeChatAgentMessageSenders'
import { useNativeChatVisualOwner } from '../media/visuals/native-chat-visual-owner'
import { useNativeChatWorkers } from '../native-chat-workers-context'

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
    </span>
  )
}

export function ItemChip({
  item,
  className
}: {
  item: BotItemNoteItem
  className?: string
}): React.JSX.Element {
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
          className={cn(NATIVE_CHAT_INLINE_CHIP, className)}
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
      className={NATIVE_CHAT_INLINE_CHIP}
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

/** A linked worker this chat started as the Started row draws it: its chip, opening the worker.
 *  Any other link's name cuts short as a chip does, whole on hover. */
function LinkName({ link }: { link: BotItemNoteLineLink }): React.JSX.Element {
  const owner = useNativeChatVisualOwner()
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const worker = useNativeChatWorkers().find((each) => each.dispatchId === link.dispatchId)
  if (worker?.address) {
    const sender: AgentMessageSender = {
      party: {
        address: worker.address,
        terminalHandle: worker.address.startsWith('term_') ? worker.address : null,
        orcaSessionId: null
      },
      name: link.name
    }
    return (
      <SenderChip
        from={{ kind: 'agent', senders: [sender], orchestration: null }}
        sender={sender}
        chatWorktreeId={owner?.worktreeId ?? activeWorktreeId}
        target={owner?.target}
        dispatchId={worker.dispatchId}
      />
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={NATIVE_CHAT_ROW_SHARE}>{link.name}</span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {link.name}
      </TooltipContent>
    </Tooltip>
  )
}

/** The line's parts, each its own piece of the one-line row (which spaces them). */
function LineWords({
  line,
  allChips,
  onAllChips,
  detailRef
}: {
  line: BotItemNoteLine & { kind: 'line' }
  allChips: boolean
  onAllChips: () => void
  detailRef?: React.Ref<HTMLSpanElement>
}): React.JSX.Element {
  const t = useTranslate()
  const chips = allChips ? line.items : line.items.slice(0, CHIPS_SHOWN)
  const hiddenChips = line.items.length - chips.length
  const after = line.link?.after ?? line.chat?.after
  return (
    <>
      {line.lead ? <span className="shrink-0">{line.lead}</span> : null}
      {line.chat ? <ChatChip chat={line.chat} /> : null}
      {line.chat && line.link && line.chat.after ? (
        <span className="shrink-0">{line.chat.after}</span>
      ) : null}
      {line.link ? <LinkName link={line.link} /> : null}
      {after ? <span className="shrink-0">{after}</span> : null}
      {chips.map((item) => (
        <ItemChip key={item.uid} item={item} />
      ))}
      {hiddenChips > 0 ? (
        <button
          type="button"
          className="shrink-0 text-xs text-chat-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onAllChips}
        >
          {t('bots.items.chat.moreItems', '+{{count}} more', { count: hiddenChips })}
        </button>
      ) : null}
      {line.tail || line.detail ? (
        <span ref={detailRef} className={line.detail ? NATIVE_CHAT_ROW_SHARE : 'shrink-0'}>
          {line.tail}
          {line.detail ? <span className="text-chat-foreground">: {line.detail}</span> : null}
        </span>
      ) : null}
    </>
  )
}

/** The words as plain text, for the row button's name. */
function lineLabel(line: BotItemNoteLine & { kind: 'line' }): string {
  return [
    line.lead,
    line.chat && [line.chat.name, line.chat.after].filter(Boolean).join(' '),
    line.link && [line.link.name, line.link.after].filter(Boolean).join(' '),
    line.items.map((item) => item.title).join(', '),
    line.tail
  ]
    .filter(Boolean)
    .join(' ')
    .concat(line.detail ? `: ${line.detail}` : '')
}

/** One item change on the shared status row; a note cut short opens whole under it. */
function QuietLine({
  line,
  at
}: {
  line: BotItemNoteLine & { kind: 'line' }
  at?: number
}): React.JSX.Element {
  const [allChips, setAllChips] = useState(false)
  const [cut, setCut] = useState(false)
  const measuredCut = useRef(false)
  const detail = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    const node = detail.current
    if (!node || !line.detail) {
      return
    }
    // A fresh observer reports the initial size after the transcript's synchronous commits.
    const observer = new ResizeObserver(() => {
      const next = node.scrollWidth > node.clientWidth + 1
      if (next !== measuredCut.current) {
        measuredCut.current = next
        setCut(next)
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [line, allChips])
  // A one-item line opens its item anywhere on it; the chip stays the keyboard target.
  const opens = line.items.length === 1 ? line.items[0]!.uid : undefined
  return (
    <div
      className={cn(opens && 'cursor-pointer')}
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
      <NativeChatEventRow
        icon={<ListTodo className="size-3.5" aria-hidden />}
        label={lineLabel(line)}
        timestamp={at}
        details={cut ? <p className="whitespace-pre-wrap">{line.detail}</p> : undefined}
      >
        <LineWords
          line={line}
          allChips={allChips}
          onAllChips={() => setAllChips(true)}
          detailRef={detail}
        />
      </NativeChatEventRow>
    </div>
  )
}

function CommentRow({
  line,
  messageId,
  belowAnother
}: {
  line: BotItemNoteLine & { kind: 'comment' }
  messageId: string
  belowAnother: boolean
}) {
  const text = stripSentImagePromptMarkers(line.text, line.images?.length ?? 0)
  return (
    // A message, so a full row gap (gap-5) below what the note drew above it, not the lines' gap-1.5.
    <div className={cn('flex flex-col items-end gap-1', belowAnother && 'mt-3.5')}>
      {line.images ? <BotItemCommentImages images={line.images} inChat /> : null}
      {/* The item heads the bubble, as on the phone. */}
      <NativeChatUserBubble className="flex flex-col gap-1.5">
        {/* A bubble's head, not a row's share: it fits the bubble instead. */}
        <ItemChip item={line.item} className="max-w-full flex-none self-start" />
        {text.trim() ? <NativeChatUserMessageBody messageId={messageId} markdown={text} /> : null}
      </NativeChatUserBubble>
    </div>
  )
}

function Lines({ note, at }: { note: BotItemNoteView; at?: number }): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {botItemNoteLines(note, t).map((line, index) =>
        line.kind === 'comment' ? (
          <CommentRow
            key={`comment:${line.item.uid}`}
            line={line}
            messageId={`item-comment:${note.noteId}:${line.item.uid}`}
            belowAnother={index > 0}
          />
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
  if (!note.run) {
    return (
      <div className="flex flex-col gap-1.5">
        <Lines note={note} at={note.at ?? timestamp} />
      </div>
    )
  }
  const line = botItemNoteRunLine(note.run, t)
  return (
    <NativeChatEventRow
      icon={<ListTodo className="size-3.5" aria-hidden />}
      label={lineLabel(line)}
      timestamp={timestamp}
      disclosureKey={`item-note-run:${note.noteId}`}
      clampDetails={false}
      details={
        <div className="flex flex-col gap-0.5">
          {note.run.map((change) => (
            <Lines key={change.noteId} note={change} />
          ))}
        </div>
      }
    >
      <LineWords line={line} allChips onAllChips={() => {}} />
    </NativeChatEventRow>
  )
}
