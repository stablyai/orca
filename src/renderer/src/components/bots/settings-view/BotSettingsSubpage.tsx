// One drill-in of the settings view: each mounts the section component that owns it.
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { BotConnectorsSection } from '../../settings/bots/BotConnectorsSection'
import { BotAgentSettings, BotPermissionSettings } from '../../settings/bots/BotGeneralSettings'
import type { BotHome } from '../../settings/bots/bot-home-files'
import { openBotHomeFileTab } from '../../settings/bots/bot-home-file-open'
import { BotLookAroundSection } from '../../settings/bots/BotLookAroundSection'
import { BotSkillsSection } from '../../settings/bots/BotSkillsSection'
import { BotMemoryBody, BotSoulBody } from '../../settings/bots/BotSoulAndMemoryBodies'
import { BotTidyUpSection } from '../../settings/bots/BotTidyUpSection'
import { BotToolsSection } from '../../settings/bots/BotToolsSection'
import { botFolderDisplay } from '../bot-presentation'
import { BotComputerPage } from './BotComputerPage'
import { BotMemoryTopicFiles } from './BotMemoryTopicFiles'
import type { BotSettingsPlace } from './bot-settings-place'
import { BotSharingPage } from './BotSharingPage'
import { BotWhoCanAskPage } from './BotWhoCanAskPage'

type Update = (updates: BotUpdateParams['updates']) => Promise<Bot | null>

function SoulPage({ bot, home }: { bot: Bot; home: BotHome }): React.JSX.Element {
  return <BotSoulBody home={home} onOpenAsFile={() => openBotHomeFileTab(bot, home, 'SOUL.md')} />
}

/** The bot's home folder isn't loaded in this window, so its files can't be read here. */
function NoHome({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  return (
    <p className="px-1 text-xs leading-5 text-muted-foreground">
      {t(
        'bots.settingsView.noHome',
        'Can’t open {{name}}’s soul and memory here. They stay in its folder at {{path}}.',
        { name: bot.name, path: botFolderDisplay(bot.folder) }
      )}
    </p>
  )
}

export function BotSettingsSubpage({
  bot,
  home,
  place,
  update
}: {
  bot: Bot
  home: BotHome | null
  place: BotSettingsPlace & { page: NonNullable<BotSettingsPlace['page']> }
  update: Update
}): React.ReactNode {
  switch (place.page) {
    case 'agent':
      return <BotAgentSettings bot={bot} update={update} />
    case 'permissions':
      return <BotPermissionSettings bot={bot} update={update} />
    case 'computer':
      return <BotComputerPage bot={bot} folderPath={home?.folderPath ?? null} />
    case 'look-around':
      return <BotLookAroundSection bot={bot} update={update} />
    case 'tidy-up':
      return <BotTidyUpSection bot={bot} update={update} />
    case 'soul':
      return home ? <SoulPage bot={bot} home={home} /> : <NoHome bot={bot} />
    case 'memory':
      return home ? (
        <BotMemoryBody
          bot={bot}
          home={home}
          defaultTab={place.memoryTab === 'history' ? 'history' : 'facts'}
          onOpenAsFile={() => openBotHomeFileTab(bot, home, 'MEMORY.md')}
        >
          <BotMemoryTopicFiles bot={bot} home={home} />
        </BotMemoryBody>
      ) : (
        <NoHome bot={bot} />
      )
    case 'connectors':
      return <BotConnectorsSection bot={bot} />
    case 'who-can-ask':
      return <BotWhoCanAskPage bot={bot} />
    case 'tools':
      return <BotToolsSection bot={bot} />
    case 'skills':
      return (
        <BotSkillsSection bot={bot} onChange={(skillProjects) => void update({ skillProjects })} />
      )
    case 'sharing':
      return <BotSharingPage bot={bot} />
  }
}
