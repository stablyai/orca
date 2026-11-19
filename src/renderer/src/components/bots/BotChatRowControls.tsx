// A bot chat row's fold and paging controls, the same in the sidebar and the Activity panel.
import { Fragment, useMemo } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { selectFrontTab } from '@/store/slices/tabs/active-tab-selection'
import { flashChatPaneRim } from '@/components/terminal-pane/input/focus/focused-pane-rim-flash'

/** Whether a chat's tab is the one in front, its fold toggle, and a flash of its pane for a press
 *  on the row of the chat already in front, for a row whose list reads its fold. */
export function useBotChatPress(
  bot: Pick<Bot, 'hostId' | 'id' | 'folderWorkspaceId'>,
  chatId: string
): {
  active: boolean
  toggle: (open: boolean) => void
  highlight: () => void
} {
  const homeKey = useMemo(() => folderWorkspaceKey(bot.folderWorkspaceId), [bot.folderWorkspaceId])
  const setBotChatFold = useAppStore((s) => s.setBotChatFold)
  const active = useAppStore((s) => {
    if ((s.activeWorkspaceKey ?? s.activeWorktreeId) !== homeKey) {
      return false
    }
    const tab = selectFrontTab(s)
    return tab?.contentType === 'agent-session' && tab.entityId === chatId
  })
  return {
    active,
    toggle: (open) => setBotChatFold(bot.hostId, bot.id, chatId, open ? 'folded' : 'open'),
    highlight: () => {
      const tab = selectFrontTab(useAppStore.getState())
      if (tab?.contentType === 'agent-session' && tab.entityId === chatId) {
        flashChatPaneRim(tab.id)
      }
    }
  }
}

/** A fold chevron's square, shared by chat rows and bot rows so their toggles match. */
export const FOLD_TOGGLE_CLASS =
  'flex shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50'

const END_TEXT = 'min-w-0 truncate text-2xs whitespace-nowrap text-muted-foreground tabular-nums'

/** The row's right edge: its time or fold summary, and the chevron, which takes the time's place on
 *  hover and stays shown while folded. Rows using it carry `group/bot-chat`. */
export function BotChatRowEnd({
  text,
  fold,
  className
}: {
  text: string | null
  /** Null for a chat with nothing under it. */
  fold: { open: boolean; name: string; onToggle: () => void } | null
  className?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!fold) {
    return text ? <span className={cn(END_TEXT, 'shrink-0', className)}>{text}</span> : null
  }
  const chevron = (
    <button
      type="button"
      aria-expanded={fold.open}
      aria-label={
        fold.open
          ? t('bots.chats.fold', 'Fold {{name}}', { name: fold.name })
          : t('bots.chats.unfold', 'Unfold {{name}}', { name: fold.name })
      }
      className={cn(
        // Positioned, so it sits over a row's own full-size button.
        'peer relative size-4',
        FOLD_TOGGLE_CLASS,
        fold.open &&
          'opacity-0 group-hover/bot-chat:opacity-100 focus-visible:opacity-100 data-[over-text]:absolute data-[over-text]:right-0'
      )}
      data-over-text={fold.open && text ? '' : undefined}
      onClick={(event) => {
        event.stopPropagation()
        fold.onToggle()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <ChevronDown className={cn('size-3.5', !fold.open && '-rotate-90')} />
    </button>
  )
  return (
    <span
      className={cn('relative flex min-w-0 shrink-0 items-center justify-end gap-1', className)}
    >
      {fold.open ? chevron : null}
      {text ? (
        <span
          className={cn(
            END_TEXT,
            fold.open && 'group-hover/bot-chat:invisible peer-focus-visible:invisible'
          )}
        >
          {text}
        </span>
      ) : null}
      {fold.open ? null : chevron}
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
