import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { Label } from '../ui/label'
import { SearchableSetting } from '../settings/section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../settings/form-controls/SettingsFormControls'
import { Switch } from '@/components/ui/switch'
import { getExperimentalSearchEntry } from '../settings/advanced/experimental-search'
import { canOpenAgentDashboardPopout } from './agent-dashboard-open-mode'

type PopoutExperimentalSettingProps = {
  id: string
  keywords?: string[]
  enabled: boolean
  mode: 'in-window' | 'popout'
  canPopout: boolean
  onEnabledChange: (enabled: boolean) => void
  onModeChange: (mode: 'in-window' | 'popout') => void
  text: {
    title: string
    description: string
    copy: string
    toggleLabel: string
    modeCopy: string
    modeAriaLabel: string
  }
}

/** One switch plus an In-window / Pop-out choice, shared by the experiments that can open a second window. */
export function PopoutExperimentalSetting({
  id,
  keywords,
  enabled,
  mode,
  canPopout,
  onEnabledChange,
  onModeChange,
  text
}: PopoutExperimentalSettingProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <SearchableSetting
      title={text.title}
      description={text.description}
      keywords={keywords}
      className="space-y-3 py-3"
      id={id}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{text.title}</Label>
          <p className="text-xs text-muted-foreground">{text.copy}</p>
        </div>
        <Switch
          checked={enabled}
          aria-label={text.toggleLabel}
          onCheckedChange={() => onEnabledChange(!enabled)}
        />
      </div>
      {enabled && canPopout ? (
        <div className="ml-4 space-y-3 border-l border-border pl-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {t('auto.components.settings.ExperimentalPane.agentDashboard.modeLabel', 'Open as')}
              </Label>
              <p className="text-xs text-muted-foreground">{text.modeCopy}</p>
            </div>
            <SettingsSegmentedControl
              value={mode}
              onChange={onModeChange}
              ariaLabel={text.modeAriaLabel}
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

type AgentDashboardExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function AgentDashboardExperimentalSetting({
  settings,
  updateSettings
}: AgentDashboardExperimentalSettingProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <PopoutExperimentalSetting
      id="experimental-agent-dashboard"
      keywords={getExperimentalSearchEntry().agentDashboard.keywords}
      enabled={settings.experimentalAgentDashboardPopout === true}
      mode={settings.experimentalAgentDashboardMode ?? 'in-window'}
      canPopout={canOpenAgentDashboardPopout()}
      onEnabledChange={(enabled) => updateSettings({ experimentalAgentDashboardPopout: enabled })}
      onModeChange={(mode) => updateSettings({ experimentalAgentDashboardMode: mode })}
      text={{
        title: t(
          'auto.components.settings.ExperimentalPane.agentDashboard.title',
          'Agent Dashboard'
        ),
        description: t(
          'auto.components.settings.ExperimentalPane.agentDashboard.description',
          'Kanban board for monitoring agents across worktrees, in-window or as a pop-out.'
        ),
        copy: t(
          'auto.components.settings.ExperimentalPane.agentDashboard.copy',
          'Adds an Agent Dashboard entry to the left sidebar. Monitor agents that need you, are working, or are done, with optional idle agents.'
        ),
        toggleLabel: t(
          'auto.components.settings.ExperimentalPane.agentDashboard.toggleLabel',
          'Toggle Agent Dashboard'
        ),
        modeCopy: t(
          'auto.components.settings.ExperimentalPane.agentDashboard.modeCopy',
          'Show the dashboard as an in-window board beside the sidebar or a separate pop-out window.'
        ),
        modeAriaLabel: t(
          'auto.components.settings.ExperimentalPane.agentDashboard.modeAriaLabel',
          'Agent Dashboard open mode'
        )
      }}
    />
  )
}
