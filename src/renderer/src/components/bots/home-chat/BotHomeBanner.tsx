// The chat pill always shows avatar + name (no tooltip needed); header containers at most 260 CSS px wide hide it entirely.
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotOnHost } from '@/lib/bot-hosts'
import { BotAvatar } from '../BotAvatar'
import './bot-home-banner.css'

/** The chat is on its bot’s page, so this opens that bot’s Activity panel. */
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
    <button
      type="button"
      data-bot-home-banner=""
      aria-label={t('bots.tabs.homeBanner', "Open {{name}}'s page", { name: bot.name })}
      onClick={(event) => {
        event.stopPropagation()
        openBotActivityPanel()
      }}
    >
      <BotAvatar bot={bot} className="rounded-full text-3xs" />
      <span data-bot-home-banner-name="">{bot.name}</span>
    </button>
  )
}
