import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { WorktreeCardMode } from '../../../../../shared/ui-chrome/ui-chrome-types'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroupSubsection } from '../section-layout/SettingsGroup'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSwitchRow
} from '../form-controls/SettingsFormControls'
import {
  getShowPinnedWorktreesInGroupsEntry,
  getSidebarEntries,
  getStartChildWorkspacesCollapsedEntry,
  getWorkspaceCardLayoutEntry
} from './appearance-sidebar-search'

type AppearanceSidebarAdvancedSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  setWorktreeCardMode: (mode: WorktreeCardMode) => void
}

export function AppearanceSidebarAdvancedSection({
  settings,
  updateSettings,
  setWorktreeCardMode
}: AppearanceSidebarAdvancedSectionProps): React.JSX.Element {
  const t = useTranslate()
  const sidebarEntries = getSidebarEntries()
  const workspaceCardLayoutEntry = getWorkspaceCardLayoutEntry()
  const showPinnedWorktreesInGroupsEntry = getShowPinnedWorktreesInGroupsEntry()
  const startChildWorkspacesCollapsedEntry = getStartChildWorkspacesCollapsedEntry()

  return (
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
              onChange={(value) => setWorktreeCardMode(value === 'compact' ? 'Compact' : 'Default')}
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
          label={t('auto.components.settings.AppearancePane.e0f9902e18', 'Show tasks button')}
          checked={settings.showTasksButton !== false}
          onChange={() =>
            updateSettings({ showTasksButton: !(settings.showTasksButton !== false) })
          }
        />
      </SearchableSetting>

      <SearchableSetting
        title={t('auto.components.settings.AppearancePane.7be0027489', 'Show automations button')}
        description={sidebarEntries[1]?.description}
        keywords={sidebarEntries[1]?.keywords ?? ['automations', 'automation', 'schedule']}
      >
        <SettingsSwitchRow
          label={t('auto.components.settings.AppearancePane.7be0027489', 'Show automations button')}
          checked={settings.showAutomationsButton !== false}
          onChange={() =>
            updateSettings({
              showAutomationsButton: !(settings.showAutomationsButton !== false)
            })
          }
        />
      </SearchableSetting>

      <SearchableSetting
        title={t('auto.components.settings.AppearancePane.d2b4ddbea0', 'Show Orca Mobile button')}
        description={sidebarEntries[2]?.description}
        keywords={sidebarEntries[2]?.keywords ?? ['mobile', 'phone', 'sidebar']}
      >
        <SettingsSwitchRow
          label={t('auto.components.settings.AppearancePane.d2b4ddbea0', 'Show Orca Mobile button')}
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
        title={showPinnedWorktreesInGroupsEntry.title}
        description={showPinnedWorktreesInGroupsEntry.description}
        keywords={showPinnedWorktreesInGroupsEntry.keywords}
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

      <SearchableSetting
        title={startChildWorkspacesCollapsedEntry.title}
        description={startChildWorkspacesCollapsedEntry.description}
        keywords={startChildWorkspacesCollapsedEntry.keywords}
      >
        <SettingsSwitchRow
          label={t(
            'auto.components.settings.AppearancePane.startChildWorkspacesCollapsed.title',
            'Start child workspaces collapsed'
          )}
          description={t(
            'auto.components.settings.AppearancePane.startChildWorkspacesCollapsed.description',
            "Collapse a parent's child workspaces the first time it gets a child."
          )}
          checked={settings.startChildWorkspacesCollapsed === true}
          onChange={() =>
            updateSettings({
              startChildWorkspacesCollapsed: !(settings.startChildWorkspacesCollapsed === true)
            })
          }
        />
      </SearchableSetting>
    </SettingsGroupSubsection>
  )
}
