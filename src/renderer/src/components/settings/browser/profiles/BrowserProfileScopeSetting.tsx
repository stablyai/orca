import { useTranslate } from '@/i18n/use-translate'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from '../../form-controls/SettingsFormControls'
import { getBrowserProfileScopeSearchEntry } from './browser-profile-scope-search'

type BrowserProfileScopeSettingProps = {
  settings: Pick<GlobalSettings, 'browserProfileScope'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserProfileScopeSetting({
  settings,
  updateSettings
}: BrowserProfileScopeSettingProps): React.JSX.Element {
  const t = useTranslate()
  const { title, description, keywords } = getBrowserProfileScopeSearchEntry()
  return (
    <SearchableSetting
      id="browser-profile-scope"
      title={title}
      description={description}
      keywords={keywords}
    >
      <SettingsRow
        label={title}
        description={description}
        control={
          <SettingsSegmentedControl
            size="sm"
            ariaLabel={title}
            value={settings.browserProfileScope ?? 'shared'}
            onChange={(browserProfileScope) => updateSettings({ browserProfileScope })}
            options={[
              {
                value: 'shared',
                label: t('settings.browser.profileScope.optionShared', 'Shared'),
                tooltip: t(
                  'settings.browser.profileScope.optionSharedTooltip',
                  'New tabs use the Default profile (or the one picked under Session & Cookies).'
                )
              },
              {
                value: 'repo',
                label: t('settings.browser.profileScope.optionRepo', 'Per repo'),
                tooltip: t(
                  'settings.browser.profileScope.optionRepoTooltip',
                  "Each repo's workspaces share one profile, created on first use."
                )
              },
              {
                value: 'worktree',
                label: t('settings.browser.profileScope.optionWorktree', 'Per workspace'),
                tooltip: t(
                  'settings.browser.profileScope.optionWorktreeTooltip',
                  'Each workspace gets its own profile, deleted with the workspace.'
                )
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
