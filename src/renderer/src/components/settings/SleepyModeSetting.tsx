import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  normalizeSleepyModeIdleMinutes,
  SLEEPY_MODE_IDLE_MINUTES,
  type SleepyModeIdleMinutes
} from '../../../../shared/sleepy-mode-settings'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSegmentedControl } from './SettingsFormControls'
import {
  getSleepyModeDescription,
  getSleepyModeIdleLabel,
  getSleepyModeSearchKeywords,
  getSleepyModeStartLabel,
  getSleepyModeTitle
} from './sleepy-mode-copy'

type SleepyModeSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function SleepyModeSetting({
  settings,
  updateSettings
}: SleepyModeSettingProps): React.JSX.Element {
  const title = getSleepyModeTitle()
  const description = getSleepyModeDescription()
  const setSleepyModeActive = useAppStore((state) => state.setSleepyModeActive)
  const idleMinutes = normalizeSleepyModeIdleMinutes(settings.sleepyModeIdleMinutes)

  return (
    <section className="space-y-3">
      <SearchableSetting
        title={title}
        description={description}
        keywords={getSleepyModeSearchKeywords()}
      >
        <div className="flex items-start justify-between gap-4 py-2">
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label>{title}</Label>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <SettingsSegmentedControl<SleepyModeIdleMinutes>
              value={idleMinutes}
              onChange={(minutes) => updateSettings({ sleepyModeIdleMinutes: minutes })}
              ariaLabel={title}
              size="sm"
              options={SLEEPY_MODE_IDLE_MINUTES.map((minutes) => ({
                value: minutes,
                label: getSleepyModeIdleLabel(minutes)
              }))}
            />
            <Button variant="secondary" size="sm" onClick={() => setSleepyModeActive(true)}>
              {getSleepyModeStartLabel()}
            </Button>
          </div>
        </div>
      </SearchableSetting>
    </section>
  )
}
