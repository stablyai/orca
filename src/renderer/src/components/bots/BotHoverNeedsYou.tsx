// The bot row hover card's Needs you part: what each ask is, in a line, and one way to answer them.
// A bare "4 need you" says neither what nor where, so the card names them and opens the bot's Needs you.
import React from 'react'
import { ArrowRight, CircleAlert, CircleHelp, Inbox, Shield, UserPlus } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useListedBotItemsNeedingOwner } from '@/lib/bot-catalog'
import { useAppStore } from '@/store'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../shared/bot-types'
import { botNeedsYouCount } from '../../../../shared/bots/bot-now'
import { botActivityRowTitle } from './bot-activity-row-title'
import { botConnectorTitleText } from './bot-connector-titles'
import { useBotNow, type BotNeedView } from './use-bot-now'

/** Asks listed by name; the rest are counted. */
const SHOWN = 3
const GLYPH = 'size-3 shrink-0 stroke-[2.25]'

type Ask = { key: string; icon: React.ReactNode; title: string; detail: string }

function askOf(need: BotNeedView, bot: Bot, t: Translate): Ask {
  const question = <CircleHelp className={cn(GLYPH, 'text-agent-question')} />
  const answer = t('bots.hover.asksQuestion', 'Waiting for your answer')
  switch (need.kind) {
    case 'chat':
      return {
        key: need.key,
        icon: question,
        title: t('bots.needs.chat', 'Your chat with {{name}}', { name: bot.name }),
        detail: answer
      }
    case 'side-chat':
      return {
        key: need.key,
        icon: question,
        title: need.title || t('bots.chats.untitled', 'New chat'),
        detail: answer
      }
    case 'session': {
      const approval = need.row.dot === 'permission'
      return {
        key: need.key,
        icon: approval ? <Shield className={cn(GLYPH, 'text-agent-question')} /> : question,
        title: botActivityRowTitle(need.row),
        detail: approval ? t('bots.hover.wantsApproval', 'Wants your approval') : answer
      }
    }
    case 'connector':
      return {
        key: need.key,
        icon: <CircleAlert className={cn(GLYPH, 'text-destructive')} />,
        title: botConnectorTitleText(need.connector.title),
        detail: t('bots.hover.signIn', 'Needs you to sign in')
      }
    case 'access':
      return {
        key: need.key,
        icon: <UserPlus className={cn(GLYPH, 'text-agent-question')} />,
        title: need.request.requester.name || need.request.requester.handle,
        detail: t('bots.hover.access', 'Asked for access')
      }
  }
}

/** Null while nothing needs the owner. `onReview` opens the bot with its Needs you showing. */
export function BotHoverNeedsYou({
  bot,
  onReview
}: {
  bot: Bot
  onReview: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const now = useBotNow(bot)
  const items = useListedBotItemsNeedingOwner(bot) ?? 0
  const total = botNeedsYouCount(now.needsYou, items)
  if (total === 0) {
    return null
  }
  const asks = now.needs.slice(0, SHOWN).map((need) => askOf(need, bot, t))
  const moreAsks = now.needs.length - asks.length
  return (
    <div className="mt-2.5 flex flex-col gap-1.5 border-t border-border pt-2">
      {/* The heading is the way in: it opens the bot's Home, where Needs you leads. */}
      <button
        type="button"
        className="group/needs -mx-1 flex min-w-0 cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 text-left text-xs font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={(event) => {
          event.stopPropagation()
          onReview()
        }}
      >
        <span className="min-w-0 flex-1 truncate">
          {t('bots.hover.needsYouHeading', '{{count}} things need you', {
            count: total,
            defaultValue_one: '1 thing needs you'
          })}
        </span>
        <span className="flex shrink-0 items-center gap-0.5 font-normal text-muted-foreground group-hover/needs:text-foreground">
          {t('bots.hover.review', 'Review')}
          <ArrowRight className="size-3" />
        </span>
      </button>
      {asks.map((ask) => (
        <Tooltip key={ask.key}>
          <TooltipTrigger asChild>
            <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4">
              {ask.icon}
              <span className="min-w-0 truncate text-foreground">{ask.title}</span>
              <span className="shrink-0 text-muted-foreground">· {ask.detail}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-80 break-words">
            {ask.title} · {ask.detail}
          </TooltipContent>
        </Tooltip>
      ))}
      {moreAsks > 0 ? (
        <div className="pl-[18px] text-xs leading-4 text-muted-foreground">
          {t('bots.hover.moreAsks', '+{{count}} more asks', {
            count: moreAsks,
            defaultValue_one: '+{{count}} more ask'
          })}
        </div>
      ) : null}
      {items > 0 ? (
        <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4">
          <Inbox className={cn(GLYPH, 'text-muted-foreground')} />
          <span className="min-w-0 truncate text-foreground">
            {t('bots.hover.itemsNeedYou', '{{count}} items it flagged for you', {
              count: items,
              defaultValue_one: '{{count}} item it flagged for you'
            })}
          </span>
        </div>
      ) : null}
    </div>
  )
}

/** Shows the open bot's panel at its Home tab, where Needs you leads, and moves focus into it.
 *  Call once the bot's page is open; the panel mounts a frame or two later. */
export function revealBotHome(): void {
  const { setRightSidebarTab, setRightSidebarOpen } = useAppStore.getState()
  setRightSidebarTab('bot-activity')
  setRightSidebarOpen(true)
  let frames = 0
  const focusPanel = (): void => {
    const panel = document.querySelector<HTMLElement>('[data-bot-home-panel]')
    if (panel) {
      panel.focus({ preventScroll: true })
    } else if (++frames < 30) {
      requestAnimationFrame(focusPanel)
    }
  }
  requestAnimationFrame(focusPanel)
}
