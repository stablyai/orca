import { translate } from '@/i18n/i18n'

export function getTabEntryOmniboxPlaceholder(): string {
  return translate(
    'auto.components.tab.bar.TabBarCreateEntry.0e5b7a3f16',
    'Search open tabs, files, URLs, agents…'
  )
}

export function getTabEntryChooseActionMessage(): string {
  return translate('auto.components.tab.bar.TabBarCreateEntry.chooseAction', 'Choose an action.')
}
