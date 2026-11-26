import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { DefaultProjectBadgeStyle } from '../../../../../shared/ui-chrome/ui-chrome-types'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '../../../store/index'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroupSubsection } from '../section-layout/SettingsGroup'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSwitchRow
} from '../form-controls/SettingsFormControls'
import type { SettingsSearchEntry } from '../search/settings-search'
import {
  getDefaultProjectBadgeStyleEntry,
  getShowPinnedWorktreesInGroupsEntry,
  getSidebarEntries
} from './appearance-sidebar-search'

type AppearanceSidebarSubsectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  workspaceCardLayoutEntry?: SettingsSearchEntry
}

export function AppearanceSidebarSubsection({
  settings,
  updateSettings,
  workspaceCardLayoutEntry
}: AppearanceSidebarSubsectionProps): React.JSX.Element {
  const t = useTranslate()
  const setWorktreeCardMode = useAppStore((state) => state.setWorktreeCardMode)
  const sidebarEntries = getSidebarEntries()
  const defaultBadgeEntry = getDefaultProjectBadgeStyleEntry()
  const showPinnedEntry = getShowPinnedWorktreesInGroupsEntry()

  return (
    <SettingsGroupSubsection
      title={t('auto.components.settings.AppearancePane.dc29f3cc0d', 'Sidebar')}
    >
      {workspaceCardLayoutEntry ? (
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
      ) : null}

      <SearchableSetting
        title={defaultBadgeEntry.title}
        description={defaultBadgeEntry.description}
        keywords={defaultBadgeEntry.keywords}
      >
        <SettingsRow
          label={defaultBadgeEntry.title}
          description={defaultBadgeEntry.description}
          control={
            <SettingsSegmentedControl<DefaultProjectBadgeStyle>
              value={settings.defaultProjectBadgeStyle === 'folder' ? 'folder' : 'letters'}
              onChange={(defaultProjectBadgeStyle) => updateSettings({ defaultProjectBadgeStyle })}
              ariaLabel={defaultBadgeEntry.title}
              options={[
                {
                  value: 'letters',
                  label: t('auto.components.repo.ProjectPeek.styleLetters', 'Letters')
                },
                {
                  value: 'folder',
                  label: t('auto.components.repo.repo.icon.bed2674f9d', 'Folder')
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
        title={showPinnedEntry.title}
        description={showPinnedEntry.description}
        keywords={showPinnedEntry.keywords}
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
  )
}
