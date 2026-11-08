import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { Label } from '../ui/label'
import { SearchableSetting } from '../settings/section-layout/SearchableSetting'
import {
  SettingsSegmentedControl,
  SettingsSwitch
} from '../settings/form-controls/SettingsFormControls'
import { getExperimentalSearchEntry } from '../settings/advanced/experimental-search'
import { canOpenAgentDashboardPopout } from './agent-dashboard-open-mode'

type AgentDashboardExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function AgentDashboardExperimentalSetting({
  settings,
  updateSettings
}: AgentDashboardExperimentalSettingProps): React.JSX.Element {
  const t = useTranslate()
  const enabled = settings.experimentalAgentDashboardPopout === true
  const mode = settings.experimentalAgentDashboardMode ?? 'in-window'

  return (
    <SearchableSetting
      title={t('auto.components.settings.ExperimentalPane.agentDashboard.title', 'Agent Dashboard')}
      description={t(
        'auto.components.settings.ExperimentalPane.agentDashboard.description',
        'Kanban board for monitoring agents across worktrees, in-window or as a pop-out.'
      )}
      keywords={getExperimentalSearchEntry(t).agentDashboard.keywords}
      className="space-y-3 py-3"
      id="experimental-agent-dashboard"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {t('auto.components.settings.ExperimentalPane.agentDashboard.title', 'Agent Dashboard')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.ExperimentalPane.agentDashboard.copy',
              'Adds an Agent Dashboard entry to the left sidebar. Monitor agents that need you, are working, or are done, with optional idle agents.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={t(
            'auto.components.settings.ExperimentalPane.agentDashboard.toggleLabel',
            'Toggle Agent Dashboard'
          )}
          onChange={() => updateSettings({ experimentalAgentDashboardPopout: !enabled })}
        />
      </div>
      {enabled && canOpenAgentDashboardPopout() ? (
        <div className="ml-4 space-y-3 border-l border-border pl-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {t('auto.components.settings.ExperimentalPane.agentDashboard.modeLabel', 'Open as')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t(
                  'auto.components.settings.ExperimentalPane.agentDashboard.modeCopy',
                  'Show the dashboard as an in-window board beside the sidebar or a separate pop-out window.'
                )}
              </p>
            </div>
            <SettingsSegmentedControl
              value={mode}
              onChange={(next) => updateSettings({ experimentalAgentDashboardMode: next })}
              ariaLabel={t(
                'auto.components.settings.ExperimentalPane.agentDashboard.modeAriaLabel',
                'Agent Dashboard open mode'
              )}
              size="sm"
              options={[
                {
                  value: 'in-window',
                  label: t(
                    'auto.components.settings.ExperimentalPane.agentDashboard.modeInWindow',
                    'In-window'
                  )
                },
                {
                  value: 'popout',
                  label: t(
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
