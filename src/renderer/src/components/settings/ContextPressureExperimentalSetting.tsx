import type { GlobalSettings } from '../../../../shared/types'
import {
  DEFAULT_CONTEXT_PRESSURE_CRITICAL_PERCENT,
  DEFAULT_CONTEXT_PRESSURE_WARN_PERCENT,
  normalizeContextPressureSoftLimits
} from '../../../../shared/agent-context-pressure'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { NumberField, SettingsSwitch } from './SettingsFormControls'
import { getExperimentalSearchEntry } from './experimental-search'
import { ContextPressureSoftLimitsEditor } from './ContextPressureSoftLimitsEditor'

type ContextPressureExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function ContextPressureExperimentalSetting({
  settings,
  updateSettings
}: ContextPressureExperimentalSettingProps): React.JSX.Element {
  const entry = getExperimentalSearchEntry().contextPressure
  const enabled = settings.experimentalContextPressure === true
  const warnPercent = settings.contextPressureWarnPercent ?? DEFAULT_CONTEXT_PRESSURE_WARN_PERCENT
  const criticalPercent =
    settings.contextPressureCriticalPercent ?? DEFAULT_CONTEXT_PRESSURE_CRITICAL_PERCENT
  const softLimits = settings.contextPressureSoftLimits ?? {}

  const commitSoftLimits = (next: Record<string, number>): void => {
    // Why: same sanitation as persistence, so the UI never round-trips an entry the store would drop.
    updateSettings({ contextPressureSoftLimits: normalizeContextPressureSoftLimits(next) })
  }

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-3 py-2"
      id="experimental-context-pressure"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.ExperimentalPane.contextPressure.title',
              'Context pressure'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.contextPressure.copy',
              'Shows a green/yellow/red context-window usage indicator on agent rows, cards, and tabs. Sessions without provider-reported usage show no indicator.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.contextPressure.toggleLabel',
            'Toggle context pressure'
          )}
          onChange={() => updateSettings({ experimentalContextPressure: !enabled })}
        />
      </div>
      {enabled ? (
        <div className="ml-4 space-y-3 border-l border-border pl-4">
          <NumberField
            label={translate(
              'auto.components.settings.ExperimentalPane.contextPressure.warnLabel',
              'Warn at'
            )}
            description={translate(
              'auto.components.settings.ExperimentalPane.contextPressure.warnDescription',
              'Percent of the effective context limit at which the indicator turns yellow.'
            )}
            value={warnPercent}
            defaultValue={DEFAULT_CONTEXT_PRESSURE_WARN_PERCENT}
            min={1}
            max={100}
            step={1}
            suffix="%"
            onChange={(value) =>
              // Why: pressure resolution degrades inverted thresholds (critical = max of the
              // pair), so keep the stored pair ordered instead of showing warn > critical.
              updateSettings({
                contextPressureWarnPercent: value,
                ...(value > criticalPercent ? { contextPressureCriticalPercent: value } : {})
              })
            }
          />
          <NumberField
            label={translate(
              'auto.components.settings.ExperimentalPane.contextPressure.criticalLabel',
              'Critical at'
            )}
            description={translate(
              'auto.components.settings.ExperimentalPane.contextPressure.criticalDescription',
              'Percent of the effective context limit at which the indicator turns red.'
            )}
            value={criticalPercent}
            defaultValue={DEFAULT_CONTEXT_PRESSURE_CRITICAL_PERCENT}
            min={1}
            max={100}
            step={1}
            suffix="%"
            onChange={(value) =>
              updateSettings({
                contextPressureCriticalPercent: value,
                ...(value < warnPercent ? { contextPressureWarnPercent: value } : {})
              })
            }
          />
          <ContextPressureSoftLimitsEditor softLimits={softLimits} onCommit={commitSoftLimits} />
        </div>
      ) : null}
    </SearchableSetting>
  )
}
