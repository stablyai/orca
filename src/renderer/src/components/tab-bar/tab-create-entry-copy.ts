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

export function getTabEntryFileNotFoundMessage(path: string): string {
  return translate(
    'auto.components.tab.bar.tabCreateEntry.fileNotFound',
    'File not found: {{path}}',
    { path }
  )
}

export function getTabEntryFileNoLongerExistsMessage(path: string): string {
  return translate(
    'auto.components.tab.bar.tabCreateEntry.fileNoLongerExists',
    'File no longer exists: {{path}}',
    { path }
  )
}

export function getTabEntryCannotOpenDirectoryMessage(path: string): string {
  return translate(
    'auto.components.tab.bar.tabCreateEntry.cannotOpenDirectory',
    'Cannot open a directory: {{path}}',
    { path }
  )
}

export function getTabEntryParentNotDirectoryMessage(path: string): string {
  return translate(
    'auto.components.tab.bar.tabCreateEntry.parentNotDirectory',
    'Cannot create file because {{path}} is not a directory.',
    { path }
  )
}

export function getTabEntryNoActiveWorktreeMessage(): string {
  return translate('auto.components.tab.bar.tabCreateEntry.noActiveWorktree', 'No active worktree.')
}
