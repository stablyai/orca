// The inbox's bots, each with how many of its items need you: picking one shows only its items.
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { botRefKey } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import { BotAvatar } from '../BotAvatar'

export function NeedsYouInboxBots({
  bots,
  counts,
  total,
  shown,
  onShow
}: {
  bots: readonly Bot[]
  counts: ReadonlyMap<string, number>
  total: number
  /** The bot whose items show; null: every bot's. */
  shown: string | null
  onShow: (botId: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <nav
      aria-label={t('bots.needsYouInbox.bots', 'Bots')}
      // No display utility of its own here: only the container query sets it, so no other rule outranks it.
      className="scrollbar-sleek min-h-0 overflow-y-auto border-r border-border p-2 @max-[60rem]:hidden"
    >
      <div className="flex flex-col gap-0.5">
        <BotFilterButton
          label={t('bots.needsYouInbox.allBots', 'All bots')}
          count={total}
          active={shown === null}
          onClick={() => onShow(null)}
        />
        {bots.map((bot) =>
          (counts.get(bot.id) ?? 0) > 0 ? (
            <BotFilterButton
              key={botRefKey(bot)}
              bot={bot}
              label={bot.name}
              count={counts.get(bot.id) ?? 0}
              active={shown === bot.id}
              onClick={() => onShow(bot.id)}
            />
          ) : null
        )}
      </div>
    </nav>
  )
}

function BotFilterButton({
  bot,
  label,
  count,
  active,
  onClick
}: {
  bot?: Bot
  label: string
  count: number
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'flex h-7 min-w-0 shrink-0 items-center gap-2 rounded-sm px-2 text-left text-[13px] outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring',
        active && 'bg-accent'
      )}
      onClick={onClick}
    >
      {bot ? <BotAvatar bot={bot} className="size-4 shrink-0 rounded-full text-[9px]" /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
    </button>
  )
}
