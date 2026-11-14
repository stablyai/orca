import type React from 'react'

import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { StatusBarItem } from '../../../../../shared/ui-chrome-types'
import type { FeatureInteractionId } from '../../../../../shared/feature-interaction-catalog'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroupDisclosure } from '../section-layout/SettingsGroupDisclosure'
import { SettingsGroupNestedRows, SettingsGroupSubsection } from '../section-layout/SettingsGroup'
import { useAppStore } from '../../../store/index'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSwitchRow
} from '../form-controls/SettingsFormControls'
import { useAvailableStatusBarToggles } from '../../status-bar/use-available-status-bar-toggles'
import { getLayoutEntries, getFollowSymlinkedDirectoriesEntry } from './appearance-search'
import {
  getSidebarEntries,
  getLeftSidebarAppearanceEntry,
  getShowPinnedWorktreesInGroupsEntry,
  getWorkspaceCardLayoutEntry
} from './appearance-sidebar-search'
import { getStatusBarToggles } from './appearance-status-bar-search'
import {
  getUsagePercentageDisplayEntry,
  USAGE_PERCENTAGE_DISPLAY_SETTING_ID
} from './appearance-usage-percentage-search'

import { LeftSidebarAppearanceSetting } from './LeftSidebarAppearanceSetting'
import { getStatusBarUsageFormatEntry } from './appearance-status-bar-usage-format-search'
import { StatusBarUsageFormatSetting } from './StatusBarUsageFormatSetting'

import { useTranslate } from '@/i18n/use-translate'
import { matchesSettingsSearch, normalizeSettingsSearchQuery } from '../search/settings-search'

type AppearanceWindowSidebarSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisiblePrimary?: boolean
}

function recordStatusBarToggleInteraction(
  id: StatusBarItem,
  recordFeatureInteraction: (feature: FeatureInteractionId) => void
): void {
  if (id === 'resource-usage') {
    recordFeatureInteraction('resource-manager')
  } else if (id === 'ports') {
    recordFeatureInteraction('ports')
  } else if (id === 'ssh') {
    recordFeatureInteraction('ssh')
  } else if (
    id === 'claude' ||
    id === 'codex' ||
    id === 'gemini' ||
    id === 'opencode-go' ||
    id === 'kimi' ||
    id === 'antigravity' ||
    id === 'minimax' ||
    id === 'grok' ||
    id === 'cursor' ||
    id === 'muse'
  ) {
    recordFeatureInteraction('usage-tracking')
  }
}

/** Window & Sidebar appearance section: sidebar/chrome appearance, status bar controls, and layout advanced settings. */
export function AppearanceWindowSidebarSection({
  settings,
  updateSettings,
  forceVisiblePrimary = false
}: AppearanceWindowSidebarSectionProps): React.JSX.Element {
  const t = useTranslate()
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isSearching = normalizeSettingsSearchQuery(searchQuery).length > 0
  const statusBarItems = useAppStore((state) => state.statusBarItems)
  const toggleStatusBarItem = useAppStore((state) => state.toggleStatusBarItem)
  const usagePercentageDisplay = useAppStore((state) => state.usagePercentageDisplay)
  const setUsagePercentageDisplay = useAppStore((state) => state.setUsagePercentageDisplay)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)
  const setWorktreeCardMode = useAppStore((state) => state.setWorktreeCardMode)
  const visibleStatusBarToggles = useAvailableStatusBarToggles(getStatusBarToggles())
  const usagePercentageDisplayEntry = getUsagePercentageDisplayEntry()
  const statusBarUsageFormatEntry = getStatusBarUsageFormatEntry()
  const statusBarUsageFormat = useAppStore((state) => state.statusBarUsageFormat)
  const setStatusBarUsageFormat = useAppStore((state) => state.setStatusBarUsageFormat)
  const leftSidebarAppearanceEntry = getLeftSidebarAppearanceEntry()
  const sidebarEntries = getSidebarEntries()
  const workspaceCardLayoutEntry = getWorkspaceCardLayoutEntry()
  const layoutEntries = getLayoutEntries()
  const followSymlinkEntry = getFollowSymlinkedDirectoriesEntry(t)
  const statusBarTitle = t('auto.components.settings.AppearancePane.3a5d06686d', 'Status bar')
  const statusBarDescription = t(
    'auto.components.settings.AppearancePane.statusBarDescription',
    'Choose which indicators appear in the status bar.'
  )
  const statusBarKeywords = ['status bar', 'indicators']
  const statusBarSectionMatches = matchesSettingsSearch(searchQuery, {
    title: statusBarTitle,
    description: statusBarDescription,
    keywords: statusBarKeywords
  })
  const statusBarControlMatches =
    matchesSettingsSearch(searchQuery, usagePercentageDisplayEntry) ||
    matchesSettingsSearch(searchQuery, statusBarUsageFormatEntry) ||
    visibleStatusBarToggles.some((toggle) =>
      matchesSettingsSearch(searchQuery, {
        title: toggle.title,
        description: toggle.description,
        keywords: toggle.keywords
      })
    )
  const sidebarAdvancedMatches = matchesSettingsSearch(searchQuery, [
    workspaceCardLayoutEntry,
    ...sidebarEntries
  ])
  const fileExplorerAdvancedMatches = matchesSettingsSearch(searchQuery, layoutEntries)
  const showStatusBarControls = !isSearching || statusBarSectionMatches || statusBarControlMatches
  const showSidebarAdvanced = !isSearching || sidebarAdvancedMatches
  const showFileExplorerAdvanced = !isSearching || fileExplorerAdvancedMatches
  const showAdvanced = showSidebarAdvanced || showFileExplorerAdvanced

  return (
    <>
      <SearchableSetting
        title={leftSidebarAppearanceEntry.title}
        description={leftSidebarAppearanceEntry.description}
        keywords={leftSidebarAppearanceEntry.keywords}
        className="space-y-2"
        forceVisible={forceVisiblePrimary}
      >
        <LeftSidebarAppearanceSetting settings={settings} updateSettings={updateSettings} />
      </SearchableSetting>

      <SearchableSetting
        title={statusBarTitle}
        keywords={statusBarKeywords}
        forceVisible={forceVisiblePrimary || statusBarSectionMatches || statusBarControlMatches}
      >
        <SettingsRow label={statusBarTitle} description={statusBarDescription} control={null} />
        {showStatusBarControls ? (
          <SettingsGroupNestedRows>
            <SearchableSetting
              id={USAGE_PERCENTAGE_DISPLAY_SETTING_ID}
              title={usagePercentageDisplayEntry.title}
              description={usagePercentageDisplayEntry.description}
              keywords={usagePercentageDisplayEntry.keywords}
            >
              <SettingsRow
                label={usagePercentageDisplayEntry.title}
                description={usagePercentageDisplayEntry.description}
                control={
                  <SettingsSegmentedControl
                    ariaLabel={usagePercentageDisplayEntry.title}
                    value={usagePercentageDisplay}
                    onChange={setUsagePercentageDisplay}
                    options={[
                      {
                        value: 'used',
                        label: t(
                          'auto.components.settings.AppearanceWindowSidebarSection.usagePercentageDisplayUsed',
                          'Used'
                        )
                      },
                      {
                        value: 'remaining',
                        label: t(
                          'auto.components.settings.AppearanceWindowSidebarSection.usagePercentageDisplayRemaining',
                          'Remaining'
                        )
                      }
                    ]}
                  />
                }
              />
            </SearchableSetting>

            <SearchableSetting
              title={statusBarUsageFormatEntry.title}
              description={statusBarUsageFormatEntry.description}
              keywords={statusBarUsageFormatEntry.keywords}
              className="space-y-2"
            >
              <StatusBarUsageFormatSetting
                format={statusBarUsageFormat}
                onChange={setStatusBarUsageFormat}
              />
            </SearchableSetting>

            {visibleStatusBarToggles.map((toggle) => {
              const enabled = statusBarItems.includes(toggle.id)
              return (
                <SearchableSetting
                  key={toggle.id}
                  title={toggle.title}
                  description={toggle.description}
                  keywords={toggle.keywords}
                >
                  <SettingsSwitchRow
                    label={toggle.title}
                    description={toggle.toggleDescription}
                    checked={enabled}
                    onChange={() => {
                      recordStatusBarToggleInteraction(toggle.id, recordFeatureInteraction)
                      toggleStatusBarItem(toggle.id)
                    }}
                    ariaLabel={toggle.title}
                  />
                </SearchableSetting>
              )
            })}
          </SettingsGroupNestedRows>
        ) : null}
      </SearchableSetting>

      {showAdvanced ? (
        <SettingsGroupDisclosure>
          {showSidebarAdvanced ? (
            <SettingsGroupSubsection
              title={t('auto.components.settings.AppearancePane.dc29f3cc0d', 'Sidebar')}
            >
              <SearchableSetting
                title={workspaceCardLayoutEntry.title}
                description={workspaceCardLayoutEntry.description}
                keywords={workspaceCardLayoutEntry.keywords}
              >
                <SettingsRow
                  label={workspaceCardLayoutEntry.title}
                  description={workspaceCardLayoutEntry.description}
                  control={
                    <SettingsSegmentedControl
                      value={settings.compactWorktreeCards ? 'compact' : 'detailed'}
                      onChange={(value) =>
                        setWorktreeCardMode(value === 'compact' ? 'Compact' : 'Default')
                      }
                      ariaLabel={workspaceCardLayoutEntry.title}
                      options={[
                        {
                          value: 'detailed',
                          label: t(
                            'auto.components.sidebar.SidebarWorkspaceOptionsMenu.cc17bd443b',
                            'Detailed'
                          )
                        },
                        {
                          value: 'compact',
                          label: t(
                            'auto.components.sidebar.SidebarWorkspaceOptionsMenu.25105b28cb',
                            'Compact'
                          )
                        }
                      ]}
                    />
                  }
                />
              </SearchableSetting>

              <SearchableSetting
                title={t('auto.components.settings.AppearancePane.e0f9902e18', 'Show tasks button')}
                description={sidebarEntries[0]?.description}
                keywords={sidebarEntries[0]?.keywords ?? ['tasks', 'sidebar', 'button']}
              >
                <SettingsSwitchRow
                  label={t(
                    'auto.components.settings.AppearancePane.e0f9902e18',
                    'Show tasks button'
                  )}
                  checked={settings.showTasksButton !== false}
                  onChange={() =>
                    updateSettings({ showTasksButton: !(settings.showTasksButton !== false) })
                  }
                />
              </SearchableSetting>

              <SearchableSetting
                title={t(
                  'auto.components.settings.AppearancePane.7be0027489',
                  'Show automations button'
                )}
                description={sidebarEntries[1]?.description}
                keywords={sidebarEntries[1]?.keywords ?? ['automations', 'automation', 'schedule']}
              >
                <SettingsSwitchRow
                  label={t(
                    'auto.components.settings.AppearancePane.7be0027489',
                    'Show automations button'
                  )}
                  checked={settings.showAutomationsButton !== false}
                  onChange={() =>
                    updateSettings({
                      showAutomationsButton: !(settings.showAutomationsButton !== false)
                    })
                  }
                />
              </SearchableSetting>

              <SearchableSetting
                title={t(
                  'auto.components.settings.AppearancePane.d2b4ddbea0',
                  'Show Orca Mobile button'
                )}
                description={sidebarEntries[2]?.description}
                keywords={sidebarEntries[2]?.keywords ?? ['mobile', 'phone', 'sidebar']}
              >
                <SettingsSwitchRow
                  label={t(
                    'auto.components.settings.AppearancePane.d2b4ddbea0',
                    'Show Orca Mobile button'
                  )}
                  // Explain the remaining Toolbox route so hiding the shortcut cannot imply feature removal.
                  description={t(
                    'auto.components.settings.AppearancePane.61d842eca0',
                    'Show the Orca Mobile shortcut in the sidebar. It remains available from Toolbox.'
                  )}
                  checked={settings.showMobileButton !== false}
                  onChange={() =>
                    updateSettings({ showMobileButton: !(settings.showMobileButton !== false) })
                  }
                />
              </SearchableSetting>

              <SearchableSetting
                title={getShowPinnedWorktreesInGroupsEntry().title}
                description={getShowPinnedWorktreesInGroupsEntry().description}
                keywords={getShowPinnedWorktreesInGroupsEntry().keywords}
              >
                <SettingsSwitchRow
                  label={t(
                    'auto.components.settings.AppearancePane.showPinnedWorktreesInGroups.title',
                    'Also show pinned worktrees in their original lists'
                  )}
                  // This opt-in duplicates pinned worktrees into natural groups while preserving Pinned.
                  description={t(
                    'auto.components.settings.AppearancePane.showPinnedWorktreesInGroups.description',
                    'Pinned worktrees stay in Pinned and also appear in All, Project, Status, and PR.'
                  )}
                  checked={settings.showPinnedWorktreesInGroups === true}
                  onChange={() =>
                    updateSettings({
                      showPinnedWorktreesInGroups: !(settings.showPinnedWorktreesInGroups === true)
                    })
                  }
                />
              </SearchableSetting>
            </SettingsGroupSubsection>
          ) : null}

          {showFileExplorerAdvanced ? (
            <SettingsGroupSubsection
              title={t('auto.components.settings.AppearancePane.8e374ce9a3', 'File explorer')}
            >
              <SearchableSetting
                title={
                  layoutEntries[0]?.title ??
                  t('auto.components.settings.AppearancePane.7e958ee950', 'Show Git-ignored files')
                }
                description={layoutEntries[0]?.description}
                keywords={layoutEntries[0]?.keywords ?? ['git', 'gitignore', 'ignored']}
              >
                <SettingsSwitchRow
                  label={t(
                    'auto.components.settings.AppearancePane.7e958ee950',
                    'Show Git-ignored files'
                  )}
                  description={t(
                    'auto.components.settings.AppearancePane.gitIgnoredGlossary',
                    'Files matched by .gitignore.'
                  )}
                  checked={settings.showGitIgnoredFiles ?? true}
                  onChange={() =>
                    updateSettings({
                      showGitIgnoredFiles: !(settings.showGitIgnoredFiles ?? true)
                    })
                  }
                />
              </SearchableSetting>
              <SearchableSetting {...followSymlinkEntry}>
                <SettingsSwitchRow
                  label={followSymlinkEntry.title}
                  description={followSymlinkEntry.description}
                  checked={settings.followSymlinkedDirectories ?? false}
                  onChange={() =>
                    updateSettings({
                      followSymlinkedDirectories: !settings.followSymlinkedDirectories
                    })
                  }
                />
              </SearchableSetting>
            </SettingsGroupSubsection>
          ) : null}
        </SettingsGroupDisclosure>
      ) : null}
    </>
  )
}
