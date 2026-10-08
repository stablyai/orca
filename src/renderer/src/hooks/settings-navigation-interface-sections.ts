import { getAppearancePaneSearchEntries } from '@/components/settings/appearance-search'
import { getChatAppearanceSearchEntries } from '@/components/settings/chat-appearance-search'
import { getChatInlineVisualsSearchEntry } from '@/components/settings/chat-inline-visuals-search'
import { getChatNamingSearchEntry } from '@/components/settings/chat-naming-search'
import { getChatUiSearchEntries } from '@/components/settings/chat-search'
import { getInputPaneSearchEntries } from '@/components/settings/input-search'
import { getNotificationsPaneSearchEntries } from '@/components/settings/notifications-search'
import { getShortcutsPaneSearchEntries } from '@/components/settings/shortcuts-search'
import { getStatsPaneSearchEntries } from '@/components/stats/stats-search'
import { translate } from '@/i18n/i18n'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import { BarChart3, Bell, Keyboard, MessageSquare, Palette, TextCursorInput } from 'lucide-react'
import type { SettingsNavigationBuildOptions } from './settings-navigation-build-options'

export function buildInterfaceSettingsSections({
  isMac,
  isWindows,
  isWebClient,
  structuredChatsInUse,
  hostQueuesChatMessages,
  managedBrowserCreationEnabled,
  mobileEmulatorCreationEnabled
}: SettingsNavigationBuildOptions): SettingsNavSection[] {
  const showDesktopOnlySettings = !isWebClient
  return [
    {
      id: 'appearance',
      title: translate('auto.hooks.useSettingsNavigationMetadata.93d88d20bf', 'Appearance'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.b11a5a48a2',
        'Theme, zoom, app and terminal appearance, sidebars, and status bar.'
      ),
      icon: Palette,
      searchEntries: getAppearancePaneSearchEntries({
        showDesktopThemeImports: showDesktopOnlySettings,
        showSystemTray: showDesktopOnlySettings && isWindows,
        showMenuBarIcon: showDesktopOnlySettings && isMac
      }),
      group: 'interface'
    },
    {
      id: 'chat',
      title: translate('settings.appearance.chat.title', 'Chat'),
      description: translate(
        'settings.chat.description',
        'Choose how new agents open, how chats look, and how they get their names.'
      ),
      icon: MessageSquare,
      searchEntries: [
        ...getChatUiSearchEntries({ isWebClient, structuredChatsInUse, hostQueuesChatMessages }),
        ...getChatAppearanceSearchEntries(),
        ...(showDesktopOnlySettings
          ? [getChatNamingSearchEntry(), getChatInlineVisualsSearchEntry()]
          : [])
      ],
      group: 'interface'
    },
    {
      id: 'input',
      title: translate('auto.hooks.useSettingsNavigationMetadata.0c6ee88a5f', 'Input & Editing'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.1f452cbd4c',
        'Selection and editing behavior.'
      ),
      icon: TextCursorInput,
      searchEntries: getInputPaneSearchEntries(),
      group: 'interface'
    },
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'notifications',
            title: translate(
              'auto.hooks.useSettingsNavigationMetadata.2eece16ad1',
              'Notifications'
            ),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.7682607591',
              'Native desktop notifications for agent and terminal events.'
            ),
            icon: Bell,
            searchEntries: getNotificationsPaneSearchEntries(),
            group: 'interface'
          }
        ]
      : []),
    {
      id: 'shortcuts',
      title: translate('auto.hooks.useSettingsNavigationMetadata.94295ebfb3', 'Shortcuts'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.dcd0d9b74f',
        'Keyboard shortcuts for common actions.'
      ),
      icon: Keyboard,
      searchEntries: getShortcutsPaneSearchEntries({
        includeManagedBrowser: managedBrowserCreationEnabled,
        includeMobileEmulator: mobileEmulatorCreationEnabled
      }),
      group: 'interface'
    },
    {
      id: 'stats',
      title: translate('auto.hooks.useSettingsNavigationMetadata.d72a58b5b9', 'Stats & Usage'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.b351014180',
        'Orca stats plus Claude, Codex, OpenCode, Muse token analytics and Grok subscription usage.'
      ),
      icon: BarChart3,
      searchEntries: getStatsPaneSearchEntries(),
      group: 'interface'
    }
  ]
}
