import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { SettingsSegmentedControl } from '../settings/form-controls/SettingsFormControls'
import { SearchableSetting } from '../settings/section-layout/SearchableSetting'
import { getExperimentalSearchEntry } from '../settings/advanced/experimental-search'

export function AppRailExperimentalSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const enabled = settings.experimentalAppRail === true
  const title = t('auto.components.settings.ExperimentalPane.appRail.title', 'App rail')
  return (
    <SearchableSetting
      title={title}
      description={t(
        'auto.components.settings.ExperimentalPane.appRail.description',
        'Icon bar on the left edge for switching between workspaces and other pages.'
      )}
      keywords={getExperimentalSearchEntry().appRail.keywords}
      className="space-y-3 py-3"
      id="experimental-app-rail"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{title}</Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.ExperimentalPane.appRail.copy',
              'Adds an icon bar to the left of the workspace list. Workspaces, Settings, and Help move onto it, and it stays visible when the list is collapsed.'
            )}
          </p>
        </div>
        <Switch
          checked={enabled}
          aria-label={t(
            'auto.components.settings.ExperimentalPane.appRail.toggleLabel',
            'Toggle app rail'
          )}
          onCheckedChange={() => void updateSettings({ experimentalAppRail: !enabled })}
        />
      </div>
      {enabled ? (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 shrink space-y-0.5">
            <Label id="app-rail-visibility-label">
              {t('appRail.visibility.settingLabel', 'Show the app rail')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t(
                'appRail.visibility.settingDescription',
                'On hover, the rail stays out of the way until you rest the pointer on the left window edge.'
              )}
            </p>
          </div>
          <SettingsSegmentedControl
            size="sm"
            ariaLabelledBy="app-rail-visibility-label"
            value={settings.appRailVisibility === 'always' ? 'always' : 'hover'}
            onChange={(value) => void updateSettings({ appRailVisibility: value })}
            options={[
              { value: 'hover', label: t('appRail.visibility.hover', 'Show on hover') },
              { value: 'always', label: t('appRail.visibility.always', 'Always show') }
            ]}
          />
        </div>
      ) : null}
    </SearchableSetting>
  )
}
