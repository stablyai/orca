import { useAppStore } from '../../../store'
import {
  renderChatSettingsSection,
  type ChatSettingsRenderContext
} from '../settings-interface-secondary-section-renderers'
import { getChatNamingSearchEntry } from '../chat-naming-search'
import { useSettingsInteractionController } from '../use-settings-interaction-controller'
import type { SettingsPersistenceModel } from './settings-persistence-test-fixture'
import { ActiveSettingsSectionProvider } from '../SettingsSection'
import { TooltipProvider } from '../../ui/tooltip'

/** The Chat settings section as the settings page renders it, saving through the queue. */
export function ChatPersistenceHarness({ model }: { model: SettingsPersistenceModel }) {
  const settings = useAppStore((state) => state.settings)
  const controller = useSettingsInteractionController(model)
  if (!settings) {
    throw new Error('Settings fixture is missing')
  }
  const context = {
    model: { ...model, settings, fontSuggestions: [] },
    interactions: controller,
    navigation: { getSectionSearchEntries: () => [getChatNamingSearchEntry()] },
    view: { isSectionMounted: () => true }
  } satisfies ChatSettingsRenderContext
  const section = renderChatSettingsSection(context)
  return (
    <TooltipProvider>
      <ActiveSettingsSectionProvider value="chat">{section}</ActiveSettingsSectionProvider>
    </TooltipProvider>
  )
}
