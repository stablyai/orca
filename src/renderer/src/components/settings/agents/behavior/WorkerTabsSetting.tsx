import { Label } from '../../../ui/label'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../../form-controls/SettingsFormControls'
import { useTranslate } from '../../../../i18n/use-translate'
import { useAppStore } from '../../../../store/index'
import type { WorkerTabsMode } from '../../../../../../shared/workspace-layout/tab-groups/worker-tab-visibility'
import { applyWorkerTabsMode } from '../../../tab-bar/worker-tabs-mode-switch'
import {
  getWorkerTabsSettingDescription,
  getWorkerTabsSettingKeywords,
  getWorkerTabsSettingTitle
} from './worker-tabs-setting-copy'

/** Settings › Agents › Worker tabs: this window's choice, not synced to the host. */
export function WorkerTabsSetting(): React.JSX.Element {
  const t = useTranslate()
  const mode = useAppStore((state) => state.workerTabsMode)
  const title = getWorkerTabsSettingTitle(t)
  const description = getWorkerTabsSettingDescription(t)
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={getWorkerTabsSettingKeywords(t)}
    >
      <div data-settings-row="" className="flex items-start justify-between gap-4 py-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>{title}</Label>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <SettingsSegmentedControl<WorkerTabsMode>
          value={mode}
          onChange={applyWorkerTabsMode}
          ariaLabel={title}
          size="sm"
          options={[
            {
              value: 'open-when-clicked',
              label: t('workerTabs.setting.openWhenClicked', 'Open when clicked')
            },
            { value: 'always-open', label: t('workerTabs.setting.alwaysOpen', 'Always open') }
          ]}
        />
      </div>
    </SearchableSetting>
  )
}
