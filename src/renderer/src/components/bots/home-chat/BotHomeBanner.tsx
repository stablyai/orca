// Home's pill shrinks to its avatar on scroll; header containers at most 260 CSS px wide hide it entirely.
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotOnHost } from '@/lib/bot-hosts'
import { BotAvatar } from '../BotAvatar'
import './bot-home-banner.css'

/** Home is on the bot's page, so the Activity panel this opens is this bot's. */
function openBotActivityPanel(): void {
  const { setRightSidebarTab, setRightSidebarOpen } = useAppStore.getState()
  setRightSidebarTab('bot-activity')
  setRightSidebarOpen(true)
}

export function BotHomeBanner({
  bot
}: {
  bot: Pick<Bot, 'id' | 'name' | 'avatar'> & BotOnHost
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-bot-home-banner=""
          aria-label={t('bots.tabs.homeBanner', "Open {{name}}'s page", { name: bot.name })}
          onClick={(event) => {
            event.stopPropagation()
            openBotActivityPanel()
          }}
        >
          <BotAvatar bot={bot} className="size-5 shrink-0 rounded-full text-3xs" />
          <span data-bot-home-banner-name="">{bot.name}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {bot.name}
      </TooltipContent>
    </Tooltip>
  )
}
