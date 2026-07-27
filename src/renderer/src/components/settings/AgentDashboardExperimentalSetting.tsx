import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSegmentedControl, SettingsSwitch } from './SettingsFormControls'
import { getExperimentalSearchEntry } from './experimental-search'

type AgentDashboardExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function AgentDashboardExperimentalSetting({
  settings,
  updateSettings
}: AgentDashboardExperimentalSettingProps): React.JSX.Element {
  const enabled = settings.experimentalAgentDashboardPopout === true
  const mode = settings.experimentalAgentDashboardMode ?? 'in-window'

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.ExperimentalPane.agentDashboard.title',
        'Agent Dashboard'
      )}
      description={translate(
        'auto.components.settings.ExperimentalPane.agentDashboard.description',
        'Kanban board for monitoring agents across worktrees, in-window or as a pop-out.'
      )}
      keywords={getExperimentalSearchEntry().agentDashboard.keywords}
      className="space-y-3 py-2"
      id="experimental-agent-dashboard"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.ExperimentalPane.agentDashboard.title',
              'Agent Dashboard'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.agentDashboard.copy',
              'Adds an Agent Dashboard entry to the left sidebar. Open it to monitor attention, working, and idle agents and jump into their live terminals.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.agentDashboard.toggleLabel',
            'Toggle Agent Dashboard'
          )}
          onChange={() => updateSettings({ experimentalAgentDashboardPopout: !enabled })}
        />
      </div>
      {enabled ? (
        <div className="ml-4 border-l border-border pl-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {translate(
                  'auto.components.settings.ExperimentalPane.agentDashboard.modeLabel',
                  'Open as'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.agentDashboard.modeCopy',
                  'Show the dashboard as an in-window board beside the sidebar or a separate pop-out window.'
                )}
              </p>
            </div>
            <SettingsSegmentedControl
              value={mode}
              onChange={(next) => updateSettings({ experimentalAgentDashboardMode: next })}
              ariaLabel={translate(
                'auto.components.settings.ExperimentalPane.agentDashboard.modeAriaLabel',
                'Agent Dashboard open mode'
              )}
              size="sm"
              options={[
                {
                  value: 'in-window',
                  label: translate(
                    'auto.components.settings.ExperimentalPane.agentDashboard.modeInWindow',
                    'In-window'
                  )
                },
                {
                  value: 'popout',
                  label: translate(
                    'auto.components.settings.ExperimentalPane.agentDashboard.modePopout',
                    'Pop-out'
                  )
                }
              ]}
            />
          </div>
        </div>
      ) : null}
    </SearchableSetting>
  )
}
