import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { Label } from '../../ui/label'
import { SearchableSetting } from '../../settings/section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../../settings/form-controls/SettingsFormControls'
import { Switch } from '@/components/ui/switch'
import { getExperimentalSearchEntry } from '../../settings/advanced/experimental-search'
import { canOpenAgentDashboardPopout, resolveAgentDashboardMode } from './agent-dashboard-open-mode'

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
  // A web client cannot pop out, so its saved pop-out choice shows as the in-window board it gets.
  const mode = resolveAgentDashboardMode(settings)

  return (
    <SearchableSetting
      title={t('auto.components.settings.ExperimentalPane.agentDashboard.title', 'Agent Dashboard')}
      description={t(
        'auto.components.settings.ExperimentalPane.agentDashboard.description',
        'Kanban board for monitoring agents across worktrees, in-window or as a pop-out.'
      )}
      keywords={getExperimentalSearchEntry().agentDashboard.keywords}
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
        <Switch
          checked={enabled}
          aria-label={t(
            'auto.components.settings.ExperimentalPane.agentDashboard.toggleLabel',
            'Toggle Agent Dashboard'
          )}
          onCheckedChange={() => updateSettings({ experimentalAgentDashboardPopout: !enabled })}
        />
      </div>
      {enabled ? (
        <div className="ml-4 space-y-3 border-l border-border pl-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {t('auto.components.settings.ExperimentalPane.agentDashboard.modeLabel', 'Open as')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t(
                  'auto.components.settings.ExperimentalPane.agentDashboard.modeCopy',
                  'Show the dashboard as an in-window board beside the sidebar, a separate pop-out window, or a right sidebar tab beside your work.'
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
                  value: 'in-window' as const,
                  label: t(
                    'auto.components.settings.ExperimentalPane.agentDashboard.modeInWindow',
                    'In-window'
                  )
                },
                {
                  value: 'popout' as const,
                  label: t(
                    'auto.components.settings.ExperimentalPane.agentDashboard.modePopout',
                    'Pop-out'
                  )
                },
                {
                  value: 'right-sidebar' as const,
                  label: t(
                    'auto.components.settings.ExperimentalPane.agentDashboard.modeRightSidebar',
                    'Right sidebar'
                  )
                }
              ].filter((option) => option.value !== 'popout' || canOpenAgentDashboardPopout())}
            />
          </div>
        </div>
      ) : null}
    </SearchableSetting>
  )
}
