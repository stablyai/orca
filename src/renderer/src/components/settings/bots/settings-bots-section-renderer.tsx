import { useEffect } from 'react'
import { useBots } from '@/lib/bot-catalog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { SettingsSection } from '../section-layout/SettingsSection'
import type { SettingsRenderContext } from '../page/settings-render-context'
import { BotSettingsView } from '../../bots/settings-view/BotSettingsView'
import {
  readBotSettingsPlace,
  setBotSettingsPlace
} from '../../bots/settings-view/bot-settings-place'
import { BotsSettingsPane } from './BotsSettingsPane'
import { BOTS_SETTINGS_SECTION_ID, botIdFromSettingsSectionId } from './bot-settings-section-ids'

/** Settings › Bots, its list of computers and their bots. */
function showBotsList(): void {
  setBotSettingsPlace('page', null)
  useAppStore.getState().openSettingsTarget({ pane: 'bots', repoId: null })
}

function BotSettingsSectionBody({ botId }: { botId: string }): React.JSX.Element | null {
  const bot = useBots().find((entry) => entry.id === botId)
  // Leaving the bot's page (another nav entry, closing Settings) brings it back at its root.
  useEffect(
    () => () => {
      if (readBotSettingsPlace('page')?.botId === botId) {
        setBotSettingsPlace('page', null)
      }
    },
    [botId]
  )
  // Re-key by bot so one bot's drafts never show on another's page.
  return bot ? (
    <BotSettingsView
      key={bot.id}
      bot={bot}
      host="page"
      onExit={showBotsList}
      onDeleted={showBotsList}
    />
  ) : null
}

export function renderBotsSettingsSections(context: SettingsRenderContext): React.ReactNode {
  const { model, navigation, view } = context
  return navigation.navSections.map((section) => {
    if (section.id === BOTS_SETTINGS_SECTION_ID) {
      return (
        <SettingsSection
          key={section.id}
          id={section.id}
          title={section.title}
          description={section.description}
          searchEntries={navigation.getSectionSearchEntries(section.id)}
        >
          {view.isSectionMounted(section.id) ? (
            <BotsSettingsPane settings={model.settings} updateSettings={model.updateSettings} />
          ) : null}
        </SettingsSection>
      )
    }
    const botId = botIdFromSettingsSectionId(section.id)
    if (botId === null) {
      return null
    }
    return (
      <SettingsSection
        key={section.id}
        id={section.id}
        title={translate('settings.bots.pageTitle', 'Bots > {{name}}', { name: section.title })}
        description={section.description}
        // The view's own crumb heads the page.
        hideHeader
        searchEntries={navigation.getSectionSearchEntries(section.id)}
      >
        {view.isSectionMounted(section.id) ? <BotSettingsSectionBody botId={botId} /> : null}
      </SettingsSection>
    )
  })
}
