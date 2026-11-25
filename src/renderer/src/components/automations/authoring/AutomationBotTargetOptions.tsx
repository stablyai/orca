import { Check } from 'lucide-react'
import { BotAvatar } from '@/components/bots/BotAvatar'
import { BotMentionHostBadge } from '@/components/bots/BotMentionHostBadge'
import { useBotHostLabels } from '@/components/bots/use-bot-host-label'
import { cn } from '@/lib/class-names'
import { botRefKey, isSameBot, type BotRef } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import { botTargetLabel } from './automation-bot-target-label'

/** The bots the target picker offers, each marked with the paired server it runs on. */
export function AutomationBotTargetOptions({
  bots,
  selectedBot,
  highlightedValue,
  onHighlight,
  onSelect
}: {
  bots: readonly Pick<Bot, 'id' | 'name' | 'avatar' | 'hostId'>[]
  selectedBot: BotRef | null
  highlightedValue: string
  onHighlight: (value: string) => void
  onSelect: (bot: BotRef) => void
}): React.JSX.Element {
  const hostLabels = useBotHostLabels(bots.map((bot) => bot.hostId))
  return (
    <>
      {bots.map((bot) => (
        <button
          key={botRefKey(bot)}
          type="button"
          onClick={() => onSelect(bot)}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHighlight(botRefKey(bot))}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground',
            highlightedValue === botRefKey(bot) && 'bg-accent text-accent-foreground'
          )}
        >
          <Check
            className={cn(
              'size-3 text-foreground',
              selectedBot && isSameBot(bot, selectedBot) ? 'opacity-100' : 'opacity-0'
            )}
          />
          <BotAvatar bot={bot} className="size-4 rounded-[4px] text-3xs" />
          <span className="truncate">{botTargetLabel(bot.name)}</span>
          <BotMentionHostBadge label={hostLabels.get(bot.hostId)} />
        </button>
      ))}
    </>
  )
}
