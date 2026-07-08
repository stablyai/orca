import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { NumberField, SettingsSwitch } from './SettingsFormControls'
import { getExperimentalSearchEntry } from './experimental-search'
import { seedTerminalPaneEvictionWarmSetOnEnable } from '../terminal-pane/terminal-pane-eviction-coordinator'
import {
  isTerminalPaneEvictionEnabled,
  resolveTerminalPaneEvictionAfterMs,
  resolveTerminalPaneEvictionWarmBudget,
  TERMINAL_PANE_EVICTION_AFTER_MINUTES_MAX,
  TERMINAL_PANE_EVICTION_AFTER_MINUTES_MIN,
  TERMINAL_PANE_EVICTION_WARM_BUDGET_MAX,
  TERMINAL_PANE_EVICTION_WARM_BUDGET_MIN
} from '../../../../shared/terminal-pane-eviction-settings'

const MS_PER_MINUTE = 60 * 1000

type TerminalPaneEvictionExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** STA-1282: experimental, opt-in, default OFF terminal pane eviction — under
 *  Settings → Experimental, agent-hibernation precedent. */
export function TerminalPaneEvictionExperimentalSetting({
  settings,
  updateSettings
}: TerminalPaneEvictionExperimentalSettingProps): React.JSX.Element {
  const enabled = isTerminalPaneEvictionEnabled(settings)
  const warmBudget = resolveTerminalPaneEvictionWarmBudget(settings)
  const afterMinutes = Math.round(resolveTerminalPaneEvictionAfterMs(settings) / MS_PER_MINUTE)

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.ExperimentalPane.terminalPaneEviction.title',
        'Free memory from hidden terminals'
      )}
      description={translate(
        'auto.components.settings.ExperimentalPane.terminalPaneEviction.description',
        'Unmounts terminal panes you have not looked at recently and restores them on demand, keeping heavy multi-agent workspaces fast.'
      )}
      keywords={getExperimentalSearchEntry().terminalPaneEviction.keywords}
      className="space-y-3 py-2"
      id="experimental-terminal-pane-eviction"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.ExperimentalPane.terminalPaneEviction.title',
              'Free memory from hidden terminals'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.terminalPaneEviction.copy',
              'Unmounts terminal panes you have not viewed recently so a busy multi-agent workspace stays fast. Their processes keep running and the pane restores from the live mirror when you open it again. Experimental while we tune restore fidelity for panes with a running agent.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.terminalPaneEviction.toggleLabel',
            'Toggle free memory from hidden terminals'
          )}
          onChange={() => {
            if (!enabled) {
              // Why: seed BEFORE the enabling settings write — with an empty warm
              // map the mount gate would mass-detach every hidden pane in the
              // enable render instead of parking it (STA-1282 enable-time seam).
              seedTerminalPaneEvictionWarmSetOnEnable()
            }
            updateSettings({ experimentalTerminalPaneEviction: !enabled })
          }}
        />
      </div>
      {enabled ? (
        <>
          <NumberField
            label={translate(
              'auto.components.settings.ExperimentalPane.terminalPaneEviction.warmBudgetLabel',
              'Terminals kept ready'
            )}
            description={translate(
              'auto.components.settings.ExperimentalPane.terminalPaneEviction.warmBudgetDescription',
              'How many recently-viewed hidden terminals stay mounted before older ones are unmounted.'
            )}
            value={warmBudget}
            min={TERMINAL_PANE_EVICTION_WARM_BUDGET_MIN}
            max={TERMINAL_PANE_EVICTION_WARM_BUDGET_MAX}
            step={1}
            onChange={(value) => updateSettings({ terminalPaneEvictionWarmBudget: value })}
          />
          <NumberField
            label={translate(
              'auto.components.settings.ExperimentalPane.terminalPaneEviction.afterMinutesLabel',
              'Unmount after'
            )}
            description={translate(
              'auto.components.settings.ExperimentalPane.terminalPaneEviction.afterMinutesDescription',
              'A hidden terminal is unmounted once it has been out of view for this long.'
            )}
            value={afterMinutes}
            min={TERMINAL_PANE_EVICTION_AFTER_MINUTES_MIN}
            max={TERMINAL_PANE_EVICTION_AFTER_MINUTES_MAX}
            step={1}
            suffix={translate(
              'auto.components.settings.ExperimentalPane.terminalPaneEviction.afterMinutesSuffix',
              'minutes'
            )}
            onChange={(minutes) => updateSettings({ terminalPaneEvictionAfterMinutes: minutes })}
          />
        </>
      ) : null}
    </SearchableSetting>
  )
}
