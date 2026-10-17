import type React from 'react'

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import { SearchableSetting } from './SearchableSetting'
import { AppearanceAdvancedDisclosure } from './AppearanceAdvancedDisclosure'
import { useAppStore } from '../../store'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'
import { AppearanceSidebarAdvancedSubsection } from './AppearanceSidebarAdvancedSubsection'
import { useAvailableStatusBarToggles } from '../status-bar/use-available-status-bar-toggles'
import {
  getLayoutEntries,
  getFollowSymlinkedDirectoriesEntry,
  getSidebarEntries,
  getStatusBarToggles,
  getUsagePercentageDisplayEntry
} from './appearance-search'
import { USAGE_PERCENTAGE_DISPLAY_SETTING_ID } from './appearance-usage-percentage-search'
import { LeftSidebarAppearanceSetting } from './LeftSidebarAppearanceSetting'
import {
  getLeftSidebarAppearanceEntry,
  getWorkspaceCardLayoutEntry
} from './appearance-sidebar-search'
import { translate } from '@/i18n/i18n'
import { matchesSettingsSearch, normalizeSettingsSearchQuery } from './settings-search'

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
    id === 'cursor'
  ) {
    recordFeatureInteraction('usage-tracking')
  }
}

export function AppearanceWindowSidebarSection({
  settings,
  updateSettings,
  forceVisiblePrimary = false
}: AppearanceWindowSidebarSectionProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isSearching = normalizeSettingsSearchQuery(searchQuery).length > 0
  const statusBarItems = useAppStore((state) => state.statusBarItems)
  const toggleStatusBarItem = useAppStore((state) => state.toggleStatusBarItem)
  const usagePercentageDisplay = useAppStore((state) => state.usagePercentageDisplay)
  const setUsagePercentageDisplay = useAppStore((state) => state.setUsagePercentageDisplay)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)
  const visibleStatusBarToggles = useAvailableStatusBarToggles(getStatusBarToggles())
  const usagePercentageDisplayEntry = getUsagePercentageDisplayEntry()
  const leftSidebarAppearanceEntry = getLeftSidebarAppearanceEntry()
  const sidebarEntries = getSidebarEntries()
  const workspaceCardLayoutEntry = getWorkspaceCardLayoutEntry()
  const layoutEntries = getLayoutEntries()
  const followSymlinkEntry = getFollowSymlinkedDirectoriesEntry()
  const statusBarTitle = translate(
    'auto.components.settings.AppearancePane.3e4175e5c6',
    'Status Bar'
  )
  const statusBarDescription = translate(
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
    <div className="space-y-2">
      <div className="divide-y divide-border/40">
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
            <div className="ml-4 divide-y divide-border/40 border-t border-border/40">
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
                          label: translate(
                            'auto.components.settings.AppearanceWindowSidebarSection.usagePercentageDisplayUsed',
                            'Used'
                          )
                        },
                        {
                          value: 'remaining',
                          label: translate(
                            'auto.components.settings.AppearanceWindowSidebarSection.usagePercentageDisplayRemaining',
                            'Remaining'
                          )
                        }
                      ]}
                    />
                  }
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
            </div>
          ) : null}
        </SearchableSetting>
      </div>

      {showAdvanced ? (
        <AppearanceAdvancedDisclosure contentClassName="ml-4 pt-4">
          <div className="space-y-4">
            {showSidebarAdvanced ? (
              <AppearanceSidebarAdvancedSubsection
                settings={settings}
                updateSettings={updateSettings}
              />
            ) : null}

            {showFileExplorerAdvanced ? (
              <div className="space-y-3">
                <SettingsSubsectionHeader
                  title={translate(
                    'auto.components.settings.AppearancePane.d496901cd0',
                    'File Explorer'
                  )}
                />
                <div className="ml-4 divide-y divide-border/40">
                  <SearchableSetting
                    title={
                      layoutEntries[0]?.title ??
                      translate(
                        'auto.components.settings.AppearancePane.0fafabcf35',
                        'Show Git-Ignored Files'
                      )
                    }
                    description={layoutEntries[0]?.description}
                    keywords={layoutEntries[0]?.keywords ?? ['git', 'gitignore', 'ignored']}
                  >
                    <SettingsSwitchRow
                      label={translate(
                        'auto.components.settings.AppearancePane.0fafabcf35',
                        'Show Git-Ignored Files'
                      )}
                      description={translate(
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
                </div>
              </div>
            ) : null}
          </div>
        </AppearanceAdvancedDisclosure>
      ) : null}
    </div>
  )
}
