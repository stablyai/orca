import type React from 'react'

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  resolveCollapsedGroupCountBadgeMode,
  type CollapsedGroupCountBadgeMode
} from '../../../../shared/collapsed-group-count-badge'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'
import { getSidebarEntries } from './appearance-search'
import {
  getCollapsedGroupCountBadgeEntry,
  getShowPinnedWorktreesInGroupsEntry,
  getWorkspaceCardLayoutEntry
} from './appearance-sidebar-search'

type AppearanceSidebarAdvancedSubsectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function AppearanceSidebarAdvancedSubsection({
  settings,
  updateSettings
}: AppearanceSidebarAdvancedSubsectionProps): React.JSX.Element {
  const setWorktreeCardMode = useAppStore((state) => state.setWorktreeCardMode)
  const sidebarEntries = getSidebarEntries()
  const workspaceCardLayoutEntry = getWorkspaceCardLayoutEntry()
  const collapsedGroupCountBadgeEntry = getCollapsedGroupCountBadgeEntry()

  return (
    <div className="space-y-3">
      <SettingsSubsectionHeader
        title={translate('auto.components.settings.AppearancePane.dc29f3cc0d', 'Sidebar')}
      />
      <div className="ml-4 divide-y divide-border/40">
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
          keywords={sidebarEntries[1]?.keywords ?? ['automations', 'automation', 'schedule']}
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

        <SearchableSetting
          title={getShowPinnedWorktreesInGroupsEntry().title}
          description={getShowPinnedWorktreesInGroupsEntry().description}
          keywords={getShowPinnedWorktreesInGroupsEntry().keywords}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.AppearancePane.showPinnedWorktreesInGroups.title',
              'Also show pinned worktrees in their original lists'
            )}
            // Why: pinned worktrees show only in Pinned by default; this opt-in
            // keeps them in Pinned and also re-lists them in their natural groups.
            description={translate(
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

        <SearchableSetting
          title={collapsedGroupCountBadgeEntry.title}
          description={collapsedGroupCountBadgeEntry.description}
          keywords={collapsedGroupCountBadgeEntry.keywords}
        >
          <SettingsRow
            label={collapsedGroupCountBadgeEntry.title}
            description={collapsedGroupCountBadgeEntry.description}
            control={
              <SettingsSegmentedControl<CollapsedGroupCountBadgeMode>
                ariaLabel={collapsedGroupCountBadgeEntry.title}
                value={resolveCollapsedGroupCountBadgeMode(settings)}
                onChange={(value) => updateSettings({ collapsedGroupCountBadge: value })}
                options={[
                  {
                    value: 'off',
                    label: translate(
                      'auto.components.settings.AppearancePane.collapsedGroupCountBadge.off',
                      'Off'
                    )
                  },
                  {
                    value: 'attention',
                    label: translate(
                      'auto.components.settings.AppearancePane.collapsedGroupCountBadge.attention',
                      'Needs you'
                    )
                  },
                  {
                    value: 'all',
                    label: translate(
                      'auto.components.settings.AppearancePane.collapsedGroupCountBadge.all',
                      'All'
                    )
                  }
                ]}
              />
            }
          />
        </SearchableSetting>
      </div>
    </div>
  )
}
