import type React from 'react'

import type { GlobalSettings, StatusBarItem } from '../../../../shared/types'
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
import { useAvailableStatusBarToggles } from '../status-bar/use-available-status-bar-toggles'
import { getLayoutEntries, getSidebarEntries, getStatusBarToggles } from './appearance-search'
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
    id === 'minimax' ||
    id === 'grok'
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
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)
  const setWorktreeCardMode = useAppStore((state) => state.setWorktreeCardMode)
  const visibleStatusBarToggles = useAvailableStatusBarToggles(getStatusBarToggles())
  const leftSidebarAppearanceEntry = getLeftSidebarAppearanceEntry()
  const sidebarEntries = getSidebarEntries()
  const workspaceCardLayoutEntry = getWorkspaceCardLayoutEntry()
  const layoutEntries = getLayoutEntries()
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
  const statusBarControlMatches = visibleStatusBarToggles.some((toggle) =>
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
              <div className="space-y-3">
                <SettingsSubsectionHeader
                  title={translate('auto.components.settings.AppearancePane.dc29f3cc0d', 'Sidebar')}
                />
                <div className="ml-4 divide-y divide-border/40">
                  {/* Why: this setting lives with the sidebar layout controls; Settings only
                  names that ownership so we do not create a second stateful control. */}
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
                              label: translate(
                                'auto.components.sidebar.SidebarWorkspaceOptionsMenu.cc17bd443b',
                                'Detailed'
                              )
                            },
                            {
                              value: 'compact',
                              label: translate(
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
                    title={translate(
                      'auto.components.settings.AppearancePane.cf81907069',
                      'Show Tasks Button'
                    )}
                    description={sidebarEntries[0]?.description}
                    keywords={sidebarEntries[0]?.keywords ?? ['tasks', 'sidebar', 'button']}
                  >
                    <SettingsSwitchRow
                      label={translate(
                        'auto.components.settings.AppearancePane.cf81907069',
                        'Show Tasks Button'
                      )}
                      checked={settings.showTasksButton !== false}
                      onChange={() =>
                        updateSettings({ showTasksButton: !(settings.showTasksButton !== false) })
                      }
                    />
                  </SearchableSetting>

                  <SearchableSetting
                    title={translate(
                      'auto.components.settings.AppearancePane.511f270ebb',
                      'Show Automations Button'
                    )}
                    description={sidebarEntries[1]?.description}
                    keywords={
                      sidebarEntries[1]?.keywords ?? ['automations', 'automation', 'schedule']
                    }
                  >
                    <SettingsSwitchRow
                      label={translate(
                        'auto.components.settings.AppearancePane.511f270ebb',
                        'Show Automations Button'
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
                    title={translate(
                      'auto.components.settings.AppearancePane.9da1020447',
                      'Show Orca Mobile Button'
                    )}
                    description={sidebarEntries[2]?.description}
                    keywords={sidebarEntries[2]?.keywords ?? ['mobile', 'phone', 'sidebar']}
                  >
                    <SettingsSwitchRow
                      label={translate(
                        'auto.components.settings.AppearancePane.9da1020447',
                        'Show Orca Mobile Button'
                      )}
                      // Why: clarify where the shortcut still lives after hiding it, so users
                      // don't think the feature is gone.
                      description={translate(
                        'auto.components.settings.AppearancePane.61d842eca0',
                        'Show the Orca Mobile shortcut in the sidebar. It remains available from Toolbox.'
                      )}
                      checked={settings.showMobileButton !== false}
                      onChange={() =>
                        updateSettings({ showMobileButton: !(settings.showMobileButton !== false) })
                      }
                    />
                  </SearchableSetting>
                </div>
              </div>
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
                      // Why: define what "git-ignored" matches; the location (file explorer)
                      // is obvious from the section header.
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
                </div>
              </div>
            ) : null}
          </div>
        </AppearanceAdvancedDisclosure>
      ) : null}
    </div>
  )
}
