import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { Label } from '../../ui/label'
import { Switch } from '../../ui/switch'
import { useAppStore } from '../../../store/index'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { matchesSettingsSearch } from '../search/settings-search'
import { getExperimentalSearchEntry } from './experimental-search'
import { HiddenExperimentalGroup } from './HiddenExperimentalGroup'
import { NumberField, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { AgentDashboardExperimentalSetting } from '../../dashboard/AgentDashboardExperimentalSetting'
import { FloatingWorkspacePopoutExperimentalSetting } from '../../floating-terminal/FloatingWorkspacePopoutExperimentalSetting'
import { EphemeralVmsExperimentalSetting } from '../virtual-machines/recipes/EphemeralVmsExperimentalSetting'
import { WslHostsExperimentalSetting } from '../wsl/hosts/WslHostsExperimentalSetting'
import { wslHostsAvailable } from '../../sidebar/use-wsl-hosts-enabled'
import {
  MAX_AGENT_HIBERNATION_IDLE_MS,
  MIN_AGENT_HIBERNATION_IDLE_MS,
  getEffectiveAgentHibernationIdleMs
} from '@/lib/agent-session/hibernation/agent-hibernation-planner'

const MS_PER_MINUTE = 60 * 1000

type ExperimentalPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  /** Unlocked by Option-clicking the Experimental title. */
  hiddenExperimentalUnlocked?: boolean
}

export function ExperimentalPane({
  settings,
  updateSettings,
  hiddenExperimentalUnlocked = false
}: ExperimentalPaneProps): React.JSX.Element {
  const t = useTranslate()
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const showPet = matchesSettingsSearch(searchQuery, [getExperimentalSearchEntry().pet])
  const showAgentDashboard = matchesSettingsSearch(searchQuery, [
    getExperimentalSearchEntry().agentDashboard
  ])
  const showFloatingWorkspacePopout = matchesSettingsSearch(searchQuery, [
    getExperimentalSearchEntry().floatingWorkspacePopout
  ])
  const showTerminalAttention = matchesSettingsSearch(searchQuery, [
    getExperimentalSearchEntry().terminalAttention
  ])
  const showAgentHibernation = matchesSettingsSearch(searchQuery, [
    getExperimentalSearchEntry().agentHibernation
  ])
  const showNewWorktreeCardStyle = matchesSettingsSearch(searchQuery, [
    getExperimentalSearchEntry().newWorktreeCardStyle
  ])
  const agentHibernationEnabled = settings.experimentalAgentHibernation === true
  // Use the planner’s clamped millisecond value/default while editing minutes.
  const agentHibernationIdleMinutes = Math.round(
    getEffectiveAgentHibernationIdleMs(settings.agentHibernationIdleMs) / MS_PER_MINUTE
  )

  return (
    <div className="space-y-8">
      <SettingsGroup>
        {showAgentDashboard ? (
          <AgentDashboardExperimentalSetting settings={settings} updateSettings={updateSettings} />
        ) : null}

        {showFloatingWorkspacePopout ? (
          <FloatingWorkspacePopoutExperimentalSetting
            settings={settings}
            updateSettings={updateSettings}
          />
        ) : null}

        {showPet ? (
          <SearchableSetting
            title={t('auto.components.settings.ExperimentalPane.dd6f0a1d45', 'Pet')}
            description={t(
              'auto.components.settings.ExperimentalPane.0e89a574ae',
              'Floating animated pet in the bottom-right corner.'
            )}
            keywords={getExperimentalSearchEntry().pet.keywords}
            className="space-y-3 py-3"
            id="experimental-pet"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 shrink space-y-1.5">
                <Label>{t('auto.components.settings.ExperimentalPane.dd6f0a1d45', 'Pet')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'auto.components.settings.ExperimentalPane.ca2219fe5e',
                    'Shows a small animated pet pinned to the bottom-right corner. Pick a character (Claudino, OpenCode, Gremlin) or upload your own PNG, APNG, GIF, WebP, JPG, or SVG from the status-bar pet menu. Hide it any time from the same menu without disabling this setting.'
                  )}
                </p>
              </div>
              <Switch
                aria-label={t('auto.components.settings.ExperimentalPane.dd6f0a1d45', 'Pet')}
                checked={settings.experimentalPet}
                onCheckedChange={(checked) => {
                  updateSettings({ experimentalPet: checked })
                }}
              />
            </div>
          </SearchableSetting>
        ) : null}

        {showTerminalAttention ? (
          <SearchableSetting
            title={t('auto.components.settings.ExperimentalPane.ec897e8d89', 'Terminal attention')}
            description={t(
              'auto.components.settings.ExperimentalPane.88b7613afb',
              'Persistent pane highlight for terminal bell and agent-completion events.'
            )}
            keywords={getExperimentalSearchEntry().terminalAttention.keywords}
            className="space-y-3 py-3"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 shrink space-y-0.5">
                <Label>
                  {t('auto.components.settings.ExperimentalPane.ec897e8d89', 'Terminal attention')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'auto.components.settings.ExperimentalPane.a20d5ea365',
                    'Keeps a pane-level highlight visible after terminal bell or agent-completion events until you interact with that pane. Experimental while we tune the signal.'
                  )}
                </p>
              </div>
              <Switch
                aria-label={t(
                  'auto.components.settings.ExperimentalPane.ec897e8d89',
                  'Terminal attention'
                )}
                checked={settings.experimentalTerminalAttention}
                onCheckedChange={(checked) =>
                  updateSettings({
                    experimentalTerminalAttention: checked
                  })
                }
              />
            </div>
          </SearchableSetting>
        ) : null}

        {showAgentHibernation ? (
          <SearchableSetting
            title={t(
              'auto.components.settings.ExperimentalPane.agentHibernation.title',
              'Agent sleep'
            )}
            description={t(
              'auto.components.settings.ExperimentalPane.agentHibernation.description',
              'Stops idle background agent terminals after the configured idle window and resumes supported sessions when you open them again.'
            )}
            keywords={getExperimentalSearchEntry().agentHibernation.keywords}
            className="space-y-3 py-3"
            id="experimental-agent-hibernation"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 shrink space-y-0.5">
                <Label>
                  {t(
                    'auto.components.settings.ExperimentalPane.agentHibernation.title',
                    'Agent sleep'
                  )}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'auto.components.settings.ExperimentalPane.agentHibernation.copy',
                    'Stops idle background agent terminals after the configured idle window and resumes supported sessions when you open them again. Agent sleep preserves launch options for agents started by Orca. Manually started agents may resume with your current Orca defaults. Experimental while we tune the safety model.'
                  )}
                </p>
              </div>
              <Switch
                checked={agentHibernationEnabled}
                aria-label={t(
                  'auto.components.settings.ExperimentalPane.agentHibernation.toggleLabel',
                  'Toggle agent sleep'
                )}
                onCheckedChange={() =>
                  updateSettings({
                    experimentalAgentHibernation: !agentHibernationEnabled
                  })
                }
              />
            </div>
            {agentHibernationEnabled ? (
              <div className="ml-4 space-y-3 border-l border-border pl-4">
                <NumberField
                  className="py-0"
                  label={t(
                    'auto.components.settings.ExperimentalPane.agentHibernation.idleMinutesLabel',
                    'Sleep after'
                  )}
                  description={t(
                    'auto.components.settings.ExperimentalPane.agentHibernation.idleMinutesDescription',
                    'How many idle minutes a completed background agent must wait before Orca can sleep it.'
                  )}
                  value={agentHibernationIdleMinutes}
                  min={MIN_AGENT_HIBERNATION_IDLE_MS / MS_PER_MINUTE}
                  max={MAX_AGENT_HIBERNATION_IDLE_MS / MS_PER_MINUTE}
                  step={1}
                  suffix={t(
                    'auto.components.settings.ExperimentalPane.agentHibernation.idleMinutesSuffix',
                    'minutes'
                  )}
                  onChange={(minutes) =>
                    updateSettings({
                      agentHibernationIdleMs: minutes * MS_PER_MINUTE
                    })
                  }
                />
              </div>
            ) : null}
          </SearchableSetting>
        ) : null}

        {showNewWorktreeCardStyle ? (
          <SearchableSetting
            title={t(
              'auto.components.settings.ExperimentalPane.worktreeCardStyle.title',
              'Card style'
            )}
            description={t(
              'auto.components.settings.ExperimentalPane.worktreeCardStyle.copy',
              'Choose how workspace cards look in the sidebar.'
            )}
            keywords={getExperimentalSearchEntry().newWorktreeCardStyle.keywords}
            className="space-y-3 py-3"
            id="experimental-new-worktree-card-style"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 shrink space-y-0.5">
                <Label>
                  {t(
                    'auto.components.settings.ExperimentalPane.worktreeCardStyle.title',
                    'Card style'
                  )}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'auto.components.settings.ExperimentalPane.worktreeCardStyle.copy',
                    'Choose how workspace cards look in the sidebar.'
                  )}
                </p>
              </div>
              <SettingsSegmentedControl<'classic' | 'experimental'>
                size="sm"
                value={
                  settings.experimentalNewWorktreeCardStyle === true ? 'experimental' : 'classic'
                }
                onChange={(style) =>
                  updateSettings({ experimentalNewWorktreeCardStyle: style === 'experimental' })
                }
                ariaLabel={t(
                  'auto.components.settings.ExperimentalPane.worktreeCardStyle.ariaLabel',
                  'Card style'
                )}
                options={[
                  {
                    value: 'classic',
                    label: t(
                      'auto.components.settings.ExperimentalPane.worktreeCardStyle.classic',
                      'Classic'
                    )
                  },
                  {
                    value: 'experimental',
                    label: t(
                      'auto.components.settings.ExperimentalPane.worktreeCardStyle.experimental',
                      'Experimental'
                    )
                  }
                ]}
              />
            </div>
          </SearchableSetting>
        ) : null}

        <EphemeralVmsExperimentalSetting settings={settings} updateSettings={updateSettings} />

        {wslHostsAvailable() ? (
          <WslHostsExperimentalSetting settings={settings} updateSettings={updateSettings} />
        ) : null}
      </SettingsGroup>

      {hiddenExperimentalUnlocked ? <HiddenExperimentalGroup /> : null}
    </div>
  )
}
