// A bot chat row's fold and paging controls, the same in the sidebar and the Activity panel.
import { Fragment } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { flashChatPaneRim } from '@/components/terminal-pane/input/focus/focused-pane-rim-flash'

/** The front tab shows this chat. Its own id matches as before; the session a /clear moved it to marks
 *  it current only when the tab is stamped with the bot's host, never on an unknown owner. */
function frontTabIsBotChat(
  tab: Pick<Tab, 'entityId' | 'executionHostId'> | null,
  hostId: string,
  chatId: string,
  liveSessionId: string | undefined
): boolean {
  if (!tab) {
    return false
  }
  return (
    tab.entityId === chatId ||
    (liveSessionId !== undefined &&
      tab.entityId === liveSessionId &&
      tab.executionHostId === hostId)
  )
}

/** Whether a chat's tab is the one in front (from the list's one read of the bot home's front chat tab),
 *  its fold toggle, and a flash of its pane for a press on the row of the chat already in front. */
export function useBotChatPress(
  bot: Pick<Bot, 'hostId' | 'id'>,
  chat: { chatId: string; liveSessionId?: string },
  front: Pick<Tab, 'id' | 'entityId' | 'executionHostId'> | null
): {
  active: boolean
  toggle: (open: boolean) => void
  highlight: () => void
} {
  const setBotChatFold = useAppStore((s) => s.setBotChatFold)
  const active = frontTabIsBotChat(front, bot.hostId, chat.chatId, chat.liveSessionId)
  return {
    active,
    toggle: (open) => setBotChatFold(bot.hostId, bot.id, chat.chatId, open ? 'folded' : 'open'),
    highlight: () => {
      if (front && active) {
        flashChatPaneRim(front.id)
      }
    }
  }
}

/** A fold chevron's square, shared by chat rows and bot rows so their toggles match. */
export const FOLD_TOGGLE_CLASS =
  'flex shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50'

/** Hides what a row's ⋯ replaces, on exactly the hover, focus and open that show the ⋯. The ⋯ and
 *  the hidden text sit in one `group/chat-end`. */
export const MENU_TAKES_PLACE =
  'group-hover/bot-chat:invisible group-has-[[data-chat-menu]:focus-within]/chat-end:invisible group-has-[[data-state=open]]/chat-end:invisible'

const END_TEXT = 'min-w-0 truncate text-3xs whitespace-nowrap text-muted-foreground tabular-nums'

/** The row's right edge: its time or fold summary, which the row's ⋯ takes the place of on hover,
 *  then the fold chevron, shown while folded or unfolded. Rows using it carry `group/bot-chat`. */
export function BotChatRowEnd({
  text,
  fold,
  menu,
  className
}: {
  text: string | null
  /** Null for a chat with nothing under it. */
  fold: { open: boolean; name: string; onToggle: () => void } | null
  /** Null for a row with no menu, whose text then stays on hover. */
  menu: React.ReactNode
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <span
      className={cn(
        'group/chat-end relative flex min-w-0 shrink-0 items-center justify-end gap-1',
        className
      )}
    >
      <span className={cn(END_TEXT, 'min-w-6', menu && MENU_TAKES_PLACE)}>{text}</span>
      <span
        className="absolute top-1/2 right-0 -translate-y-1/2 data-[fold]:right-5"
        data-fold={fold ? '' : undefined}
      >
        {menu}
      </span>
      {fold ? (
        <button
          type="button"
          aria-expanded={fold.open}
          aria-label={
            fold.open
              ? t('bots.chats.fold', 'Fold {{name}}', { name: fold.name })
              : t('bots.chats.unfold', 'Unfold {{name}}', { name: fold.name })
          }
          // Positioned, so it sits over a row's own full-size button.
          className={cn('relative size-4', FOLD_TOGGLE_CLASS)}
          onClick={(event) => {
            event.stopPropagation()
            fold.onToggle()
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <ChevronDown className={cn('size-3.5', !fold.open && '-rotate-90')} />
        </button>
      ) : null}
    </span>
  )
}

/** A list's paging, all in one spot on the left: "Show N more · Show fewer". */
export function BotChatPaging({
  more,
  onFewer,
  className
}: {
  more: readonly { label: string; onClick: () => void }[]
  /** Set once a step is open. */
  onFewer: (() => void) | null
  className?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const links = onFewer
    ? [...more, { label: t('bots.chats.showFewer', 'Show fewer'), onClick: onFewer }]
    : more
  if (links.length === 0) {
    return null
  }
  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-1 text-2xs text-muted-foreground',
        className
      )}
    >
      {links.map((link, index) => (
        <Fragment key={link.label}>
          {index > 0 ? <span aria-hidden>·</span> : null}
          <button
            type="button"
            className="cursor-pointer rounded-sm whitespace-nowrap outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={link.onClick}
          >
            {link.label}
          </button>
        </Fragment>
      ))}
    </div>
  )
}
