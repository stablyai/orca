// Hover or keyboard focus swaps the age for Done, Snooze, and More on open items.
import { memo, useId } from 'react'
import { Check, CircleCheck, CircleSlash, Clock, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useMenuPointerExitClose } from '@/components/ui/menu-pointer-exit-close'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import {
  botItemActivityAt,
  isBotItemLive,
  type BotItem
} from '../../../../../shared/bots/bot-items'
import type { Bot } from '../../../../../shared/bot-types'
import { botItemQuestionLine } from '../../../../../shared/bots/bot-item-ask'
import { structuralValuesEqual } from '../../../../../shared/collections/structural-value-equality'
import { BotRowHoverCard } from '../BotPanelRow'
import { BotItemNumberColumn } from './BotItemNumberColumn'
import { BotItemRowFace } from './BotItemRowFace'
import { BotItemStatusIcon } from './BotItemStatusIcon'
import { BOT_ITEM_ROW_ACTION_OVERLAY } from './bot-item-row-hover-actions'
import { BotItemSnoozeMenuItems, type BotItemSnoozing } from './BotItemSnooze'
import { formatBotItemSnoozeTime } from './bot-item-snooze-time'

type BotItemRowProps = {
  item: BotItem
  stale: boolean
  /** In the Snoozed group: grey like Stale, its wake time where the age goes. */
  snoozed?: boolean
  snoozing: BotItemSnoozing
  unseen: boolean
  selected: boolean
  /** Some row is checked: every row shows its checkbox. */
  selecting: boolean
  now: number
  onSelect: (item: BotItem, selected: boolean, range: boolean) => void
  onAction: (item: BotItem, action: BotItemRowAction) => void
  /** Its bot, in a group's merged list. */
  face?: Bot | null
  /** Its chat's name, when the list shows chats beyond the one it is about. */
  place?: string | null
  /** In the Tab order: a long group keeps one row there and moves between rows with arrows. */
  tabbable?: boolean
  /** Announced as a list item itself; false when its window's slot is the item. */
  listItem?: boolean
}

// Whether an item has a live worker, worked out once per item object: the comparison and the render
// share it, so a fresh read walks each item's links once, as rendering it did.
const liveByItem = new WeakMap<BotItem, boolean>()
function itemLive(item: BotItem): boolean {
  let live = liveByItem.get(item)
  if (live === undefined) {
    live = isBotItemLive(item)
    liveByItem.set(item, live)
  }
  return live
}

type ItemFieldEqual = (a: BotItem, b: BotItem) => boolean
const skipped: ItemFieldEqual = () => true

/** How each field compares when the version is unchanged. Only the item's own write bumps the version,
 *  so its long texts (which the row never shows) skip; of its links the row shows only whether one is
 *  live; its question by its event; joined parts (names, chat) compare by value. Typed per field, so a new field
 *  needs a rule. */
const ITEM_FIELD_RULES: Record<keyof BotItem, ItemFieldEqual> = {
  uid: (a, b) => a.uid === b.uid,
  number: (a, b) => a.number === b.number,
  owner: (a, b) => structuralValuesEqual(a.owner, b.owner),
  title: (a, b) => a.title === b.title,
  description: skipped,
  doneMeans: skipped,
  status: (a, b) => a.status === b.status,
  chat: (a, b) => structuralValuesEqual(a.chat, b.chat),
  madeBy: (a, b) => structuralValuesEqual(a.madeBy, b.madeBy),
  // A question is one item event, which never changes once written; a host on another release reads it
  // with other fields (ask, or gist and decisions).
  question: (a, b) =>
    a.question?.eventId === b.question?.eventId &&
    Object.keys(a.question ?? {}).join() === Object.keys(b.question ?? {}).join(),
  // Read by the item's own view; the row never shows it.
  waitingAsk: skipped,
  closeNote: (a, b) => a.closeNote === b.closeNote,
  wait: (a, b) => a.wait?.text === b.wait?.text && a.wait?.at === b.wait?.at,
  links: (a, b) => itemLive(a) === itemLive(b),
  version: (a, b) => a.version === b.version,
  lastEventId: (a, b) => a.lastEventId === b.lastEventId,
  othersLastEventId: (a, b) => a.othersLastEventId === b.othersLastEventId,
  snoozedUntil: (a, b) => a.snoozedUntil === b.snoozedUntil,
  lastActivityAt: (a, b) => a.lastActivityAt === b.lastActivityAt,
  createdAt: (a, b) => a.createdAt === b.createdAt,
  updatedAt: (a, b) => a.updatedAt === b.updatedAt,
  closedAt: (a, b) => a.closedAt === b.closedAt
}
const ITEM_FIELD_EQUALS = Object.values(ITEM_FIELD_RULES)

/** Equal for the row: a fresh host read decodes every item anew. Constant work per item. */
function sameItem(a: BotItem, b: BotItem): boolean {
  if (a === b) {
    return true
  }
  if (a.version !== b.version || a.updatedAt !== b.updatedAt) {
    return false
  }
  return ITEM_FIELD_EQUALS.every((equal) => equal(a, b))
}

/** The item compares by value, as a fresh host read decodes it anew; every other prop by identity. */
function sameRowProps(prev: BotItemRowProps, next: BotItemRowProps): boolean {
  // The minute clock changes every row's age at once: that render needs no comparison.
  if (prev.now !== next.now) {
    return false
  }
  const before: Readonly<Record<string, unknown>> = prev
  const after: Readonly<Record<string, unknown>> = next
  const keys = Object.keys(after)
  return (
    keys.length === Object.keys(before).length &&
    keys.every((key) =>
      key === 'item' ? sameItem(prev.item, next.item) : Object.is(before[key], after[key])
    )
  )
}

export type BotItemRowAction = { kind: 'open' } | { kind: 'done' } | { kind: 'cancel' }

function BotItemRowView({
  item,
  stale,
  snoozed = false,
  snoozing,
  unseen,
  selected,
  selecting,
  now,
  onSelect,
  onAction,
  face = null,
  place = null,
  tabbable = true,
  listItem = true
}: BotItemRowProps): React.JSX.Element {
  const t = useTranslate()
  const closed = item.status === 'done' || item.status === 'canceled'
  const doneLabel = t('bots.items.row.done', 'Done')
  const snoozeLabel = t('bots.items.snooze.menu', 'Snooze')
  // Needs you's question, or what Waiting waits on, shows in the row's hover card; the row stays one
  // line like the others.
  const question = !stale && !snoozed && item.status === 'needs_you' ? item.question : null
  const wait = !snoozed && item.status === 'waiting' ? item.wait : null
  const questionId = useId()
  const checkbox = selecting || selected
  const { rowRef, triggerRef, ...menu } = useMenuPointerExitClose<
    HTMLDivElement,
    HTMLButtonElement
  >()
  return (
    <div
      ref={rowRef}
      role={listItem ? 'listitem' : undefined}
      data-bot-item={item.number}
      className={cn(
        'group/item relative flex min-w-0 items-start gap-2 rounded-sm px-2 py-1 hover:bg-accent has-[:focus-visible]:bg-accent has-[[aria-expanded=true]]:bg-accent has-[[data-state=open]]:bg-accent',
        selected && 'bg-accent'
      )}
    >
      <span className="group/check flex h-5 w-4 shrink-0 items-center justify-center">
        <span className={cn('flex', checkbox ? 'hidden' : 'group-hover/check:hidden')}>
          <BotItemStatusIcon status={item.status} live={itemLive(item)} stale={stale || snoozed} />
        </span>
        <Checkbox
          tabIndex={tabbable ? undefined : -1}
          aria-label={t('bots.items.row.select', 'Select {{title}}', { title: item.title })}
          checked={selected}
          className={cn('size-3.5', !checkbox && 'hidden group-hover/check:flex')}
          onClick={(event) => {
            event.preventDefault()
            onSelect(item, !selected, event.shiftKey)
          }}
        />
      </span>
      {face ? <BotItemRowFace bot={face} /> : null}
      <BotRowHoverCard
        card={
          question ? (
            <BotItemQuestionCard title={item.title} question={question} />
          ) : wait ? (
            <>
              <p className="font-medium text-foreground">{item.title}</p>
              <p className="mt-1 text-muted-foreground">{wait.text}</p>
            </>
          ) : null
        }
      >
        <button
          type="button"
          data-bot-item-open=""
          tabIndex={tabbable ? undefined : -1}
          title={question || wait ? undefined : item.title}
          aria-describedby={question || wait ? questionId : undefined}
          className="min-w-0 flex-1 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => onAction(item, { kind: 'open' })}
        >
          <span className="flex min-w-0 items-start">
            <BotItemNumberColumn number={item.number} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-[13px] leading-5',
                    closed ? 'text-muted-foreground' : 'text-foreground'
                  )}
                >
                  {item.title}
                </span>
                {/* Only open rows have hover actions, so only they give the age up to them. */}
                <span
                  className={cn(
                    'flex shrink-0 items-center gap-2',
                    !closed &&
                      'group-has-[:focus-visible]/item:invisible group-hover/item:invisible group-has-[[aria-expanded=true]]/item:invisible'
                  )}
                >
                  {unseen ? (
                    <span aria-hidden className="size-1.5 rounded-full bg-foreground" />
                  ) : null}
                  {snoozed && item.snoozedUntil !== null ? (
                    <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                      {t('bots.items.snooze.rowUntil', 'until {{when}}', {
                        when: formatBotItemSnoozeTime(item.snoozedUntil, now)
                      })}
                    </span>
                  ) : (
                    <span className="text-xs tabular-nums text-muted-foreground @max-[284px]:hidden">
                      {formatShortTimeAgo(botItemActivityAt(item, now), now)}
                    </span>
                  )}
                </span>
              </span>
              {/* A group's list names the chat a row is from on a quiet second line. */}
              {place ? (
                <span className="block truncate text-xs leading-4 text-muted-foreground">
                  {place}
                </span>
              ) : null}
            </span>
          </span>
        </button>
      </BotRowHoverCard>
      {question || wait ? (
        <span id={questionId} hidden>
          {question ? question.text : wait?.text}
        </span>
      ) : null}
      {closed ? null : (
        // Keep actions in the tab order so focus can move from the title to an action.
        <span
          className={cn(
            BOT_ITEM_ROW_ACTION_OVERLAY,
            'pointer-events-none flex gap-0.5 opacity-0 group-has-[:focus-visible]/item:pointer-events-auto group-has-[:focus-visible]/item:opacity-100 group-hover/item:pointer-events-auto group-hover/item:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100'
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost-on-accent"
                size="icon-xs"
                aria-label={doneLabel}
                tabIndex={tabbable ? undefined : -1}
                onClick={() => onAction(item, { kind: 'done' })}
              >
                <Check className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {doneLabel}
            </TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost-on-accent"
                    size="icon-xs"
                    aria-label={snoozeLabel}
                    tabIndex={tabbable ? undefined : -1}
                  >
                    <Clock className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {snoozeLabel}
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <BotItemSnoozeMenuItems items={[item]} snoozing={snoozing} inSubmenu={false} />
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu open={menu.open} onOpenChange={menu.onOpenChange}>
            <DropdownMenuTrigger asChild ref={triggerRef} {...menu.triggerProps}>
              <Button
                variant="ghost-on-accent"
                size="icon-xs"
                aria-label={t('bots.items.row.more', 'More')}
                tabIndex={tabbable ? undefined : -1}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" {...menu.contentProps}>
              <DropdownMenuItem onSelect={() => onAction(item, { kind: 'done' })}>
                <CircleCheck />
                {t('bots.items.menu.done', 'Done')}
              </DropdownMenuItem>
              <BotItemSnoozeMenuItems items={[item]} snoozing={snoozing} />
              <DropdownMenuItem onSelect={() => onAction(item, { kind: 'cancel' })}>
                <CircleSlash />
                {t('bots.items.menu.cancel', 'Cancel')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      )}
    </div>
  )
}

/** Memoized: an update re-renders only the rows whose item or flags changed, so its handlers take the
 *  item and stay the same across the list's renders. The item compares by value, as every host read
 *  decodes every item anew; only the rows drawn pay the comparison. */
export const BotItemRow = memo(BotItemRowView, sameRowProps)

/** The row's hover card while it needs you: the title, one line of the bot's words, then each question
 *  line with its quick replies (read-only here; they answer on the item). */
function BotItemQuestionCard({
  title,
  question
}: {
  title: string
  question: NonNullable<BotItem['question']>
}): React.JSX.Element {
  const t = useTranslate()
  // A host before question lines sends only the words.
  const gist = question.gist ?? botItemQuestionLine(question.text)
  return (
    <>
      <p className="font-medium text-foreground">{title}</p>
      {gist ? <p className="mt-1 truncate text-muted-foreground">{gist}</p> : null}
      {question.decisions?.map((decision) => (
        <div key={decision.question} className="mt-2">
          <p className="text-foreground">{botItemQuestionLine(decision.question)}</p>
          {decision.replies.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {decision.replies.map((reply) => (
                <span
                  key={reply.label}
                  className="rounded-[10px] border border-question-option-border px-2 py-0.5 text-[11.5px] leading-4 text-foreground"
                >
                  {reply.label}
                  {reply.recommended ? (
                    <span className="ml-[5px] whitespace-nowrap text-[10.5px] text-muted-foreground">
                      {t('bots.items.ask.recommended', 'Recommended')}
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </>
  )
}
