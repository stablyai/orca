import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { getExperimentalSearchEntry } from './experimental-search'
import { SettingsSwitch } from './SettingsFormControls'

type LargerSidebarSectionsSettingProps = {
  enabled: boolean
  onToggle: () => void
}

export function LargerSidebarSectionsSetting({
  enabled,
  onToggle
}: LargerSidebarSectionsSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.ExperimentalPane.largerSidebarSections.title',
        'Larger sidebar sections'
      )}
      description={translate(
        'auto.components.settings.ExperimentalPane.largerSidebarSections.description',
        'Preview larger project and section headers in the worktree sidebar.'
      )}
      keywords={getExperimentalSearchEntry().largerSidebarSections.keywords}
      className="space-y-3 py-2"
      id="experimental-larger-sidebar-sections"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.ExperimentalPane.largerSidebarSections.title',
              'Larger sidebar sections'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.largerSidebarSections.copy',
              'Increases project and section header type, repo icons, and slightly pulls grouped workspace cards left.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.largerSidebarSections.toggleLabel',
            'Toggle larger sidebar sections'
          )}
          onChange={onToggle}
        />
      </div>
    </SearchableSetting>
  )
}
