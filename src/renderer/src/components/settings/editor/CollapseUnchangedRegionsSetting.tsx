import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Label } from '../../ui/label'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'

const KEYWORDS = [
  'diff',
  'collapse',
  'hide unchanged',
  'unchanged lines',
  'fold',
  'context lines',
  'hunk'
]

function getTitle(t: Translate = translate): string {
  return t(
    'auto.components.settings.GeneralEditorSettingsSection.916c5582f2',
    'Collapse unchanged regions'
  )
}

function getDescription(t: Translate = translate): string {
  return t(
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
  const t = useTranslate()
  const title = getTitle(t)
  const description = getDescription(t)

  return (
    <SearchableSetting
      id={GENERAL_SETTING_ANCHORS.collapseUnchanged}
      title={title}
      description={description}
      keywords={KEYWORDS}
      className="flex items-center justify-between gap-4 py-3"
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
            label: t('auto.components.settings.GeneralEditorSettingsSection.bf16ef0af2', 'Off')
          },
          {
            value: 'on',
            label: t('auto.components.settings.GeneralEditorSettingsSection.3f6892f307', 'On')
          }
        ]}
      />
    </SearchableSetting>
  )
}
