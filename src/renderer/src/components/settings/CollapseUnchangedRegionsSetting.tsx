import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSegmentedControl } from './SettingsFormControls'

const KEYWORDS = [
  'diff',
  'collapse',
  'hide unchanged',
  'unchanged lines',
  'fold',
  'context lines',
  'hunk'
]

function getTitle(): string {
  return translate(
    'auto.components.settings.GeneralEditorSettingsSection.collapseUnchangedTitle',
    'Collapse Unchanged Regions'
  )
}

function getDescription(): string {
  return translate(
    'auto.components.settings.GeneralEditorSettingsSection.collapseUnchangedDescription',
    'Show only changed lines and a little surrounding context in a file diff, hiding the rest behind expandable bands. The View All Changes diff always collapses this way.'
  )
}

export function CollapseUnchangedRegionsSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const title = getTitle()
  const description = getDescription()

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={KEYWORDS}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <SettingsSegmentedControl
        ariaLabel={title}
        value={settings.diffCollapseUnchangedRegions ? 'on' : 'off'}
        onChange={(option) => {
          void updateSettings({ diffCollapseUnchangedRegions: option === 'on' })
        }}
        options={[
          {
            value: 'off',
            label: translate(
              'auto.components.settings.GeneralEditorSettingsSection.bf16ef0af2',
              'Off'
            )
          },
          {
            value: 'on',
            label: translate(
              'auto.components.settings.GeneralEditorSettingsSection.3f6892f307',
              'On'
            )
          }
        ]}
      />
    </SearchableSetting>
  )
}
