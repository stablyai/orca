import { getAppearancePaneSearchEntries } from '@/components/settings/appearance/appearance-search'
import { getChatAppearanceSearchEntries } from '@/components/settings/appearance/chat/chat-appearance-search'
import { getChatBehaviorSearchEntries } from '@/components/settings/chat/chat-behavior-search'
import { getChatTurnActivitySearchEntries } from '@/components/settings/chat/chat-turn-activity-search'
import { getChatNamingSearchEntry } from '@/components/settings/chat/chat-naming-search'
import { getChatInlineVisualsSearchEntry } from '@/components/settings/chat/chat-inline-visuals-search'
import { getChatLaunchSearchEntries } from '@/components/settings/chat/chat-launch-search'
import { getChatPermissionSearchEntry } from '@/components/settings/chat/chat-permission-search'
import { getInputPaneSearchEntries } from '@/components/settings/input/input-search'
import { getNotificationsPaneSearchEntries } from '@/components/settings/notifications/notifications-search'
import { getShortcutsPaneSearchEntries } from '@/components/settings/shortcuts/shortcuts-search'
import { getStatsPaneSearchEntries } from '@/components/stats/stats-search'
import { getFloatingWorkspaceSearchEntries } from '@/components/settings/floating-workspaces/floating-workspace-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsNavSection } from '@/components/settings/navigation/settings-navigation-types'
import {
  BarChart3,
  Bell,
  Keyboard,
  MessageSquare,
  Palette,
  PanelsTopLeft,
  TextCursorInput
} from 'lucide-react'
import type { SettingsNavigationBuildOptions } from './settings-navigation-build-options'

export function buildInterfaceSettingsSections(
  {
    isMac,
    isWindows,
    isWebClient,
    hostQueuesMessages,
    typedChatPermissions,
    managedBrowserCreationEnabled,
    mobileEmulatorCreationEnabled
  }: SettingsNavigationBuildOptions,
  t: Translate = translate
): SettingsNavSection[] {
  const showDesktopOnlySettings = !isWebClient
  return [
    {
      id: 'appearance',
      title: t('auto.hooks.useSettingsNavigationMetadata.93d88d20bf', 'Appearance'),
      description: t(
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
      title: t('settings.appearance.chat.title', 'Chat UI'),
      description: t('settings.chat.description', 'Choose how chats look and behave.'),
      icon: MessageSquare,
      searchEntries: [
        ...(showDesktopOnlySettings ? getChatLaunchSearchEntries(t) : []),
        getChatPermissionSearchEntry(typedChatPermissions),
        ...getChatAppearanceSearchEntries(t),
        ...getChatTurnActivitySearchEntries(t),
        ...getChatBehaviorSearchEntries(t).filter(
          (entry) => hostQueuesMessages || entry.targetSectionId !== 'chat-queue-follow-ups'
        ),
        ...(showDesktopOnlySettings
          ? [getChatNamingSearchEntry(), getChatInlineVisualsSearchEntry()]
          : [])
      ],
      group: 'interface'
    },
    {
      id: 'input',
      title: t('auto.hooks.useSettingsNavigationMetadata.0c6ee88a5f', 'Input & Editing'),
      description: t(
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
            title: t('auto.hooks.useSettingsNavigationMetadata.2eece16ad1', 'Notifications'),
            description: t(
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
      title: t('auto.hooks.useSettingsNavigationMetadata.94295ebfb3', 'Shortcuts'),
      description: t(
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
      title: t('auto.hooks.useSettingsNavigationMetadata.d72a58b5b9', 'Stats & Usage'),
      description: t(
        'auto.hooks.useSettingsNavigationMetadata.b351014180',
        'Orca stats plus Claude, Codex, OpenCode, Muse token analytics and Grok subscription usage.'
      ),
      icon: BarChart3,
      searchEntries: getStatsPaneSearchEntries(),
      group: 'interface'
    },
    {
      id: 'floating-workspace',
      title: t('auto.hooks.useSettingsNavigationMetadata.65b19f5bde', 'Floating Workspace'),
      description: showDesktopOnlySettings
        ? t(
            'auto.hooks.useSettingsNavigationMetadata.2d0659f6f0',
            'Global terminal, browser, and markdown tabs.'
          )
        : t(
            'auto.hooks.useSettingsNavigationMetadata.floatingWorkspaceWebDescription',
            'Global terminal and markdown tabs.'
          ),
      icon: PanelsTopLeft,
      searchEntries: getFloatingWorkspaceSearchEntries({
        includeBrowser: showDesktopOnlySettings
      }),
      group: 'interface'
    }
  ]
}
