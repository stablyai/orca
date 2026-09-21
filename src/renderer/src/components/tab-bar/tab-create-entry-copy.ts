import { translate } from '@/i18n/i18n'

export function getTabEntryOmniboxPlaceholder(): string {
  return translate(
    'auto.components.tab.bar.TabBarCreateEntry.omniboxPlaceholderWithHistory',
    'Search open tabs, history, files, URLs, agents…'
  )
}

export function getTabEntryChooseActionMessage(): string {
  return translate('auto.components.tab.bar.TabBarCreateEntry.chooseAction', 'Choose an action.')
}
