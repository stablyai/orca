// The Activity entry that put the item in Needs you, edged in amber, and where the header's Reply leads;
// and the item's making, dated, since its first entry is the only place the page says when it was made.
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { BotItemClampedOpenContext } from './BotItemClampedText'

/** Seen when this much of the entry's top shows, not a sliver of it. */
export const BOT_ITEM_NEEDS_YOU_TOP_ATTRIBUTE = 'data-bot-item-needs-you-top'

const MADE = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } as const
const MADE_YEAR = { ...MADE, year: 'numeric' } as const

/** The item's making, by date as well: with its year when that isn't this one. */
export function botItemMadeAt(at: number): string {
  const sameYear = new Date(at).getFullYear() === new Date().getFullYear()
  return uiDateTimeFormat(sameYear ? MADE : MADE_YEAR).format(at)
}

export type BotItemNeedsYouMark = {
  /** Takes the entry's element, so its place can be watched. */
  setNode: (node: HTMLElement | null) => void
  /** The entry's id, which the comment box names as what it answers after a jump. */
  id: string
  /** Bumped on each jump to the entry: its cut text opens. */
  opened: number
}

/** The entry that asked, edged in amber so it stands out among the rest, and where Reply leads. */
export function BotItemNeedsYouMarkBox({
  mark,
  children
}: {
  mark?: BotItemNeedsYouMark
  children: React.ReactNode
}): React.JSX.Element {
  return (
    // Bled past the column like a comment card, so a jump's ring wraps the card's own edge.
    <div
      ref={mark?.setNode}
      id={mark?.id}
      data-bot-item-needs-you={mark ? '' : undefined}
      className={
        mark
          ? 'relative -mx-2 scroll-mt-3 rounded-[10px] px-2 before:pointer-events-none before:absolute before:inset-y-1 before:-left-0.5 before:w-0.5 before:rounded-full before:bg-agent-question'
          : undefined
      }
    >
      {mark ? (
        <span
          aria-hidden
          {...{ [BOT_ITEM_NEEDS_YOU_TOP_ATTRIBUTE]: '' }}
          className="pointer-events-none absolute inset-x-0 top-0 h-6 max-h-full"
        />
      ) : null}
      <BotItemClampedOpenContext value={mark?.opened ?? 0}>{children}</BotItemClampedOpenContext>
    </div>
  )
}
