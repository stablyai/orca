import type { GlobalSettings } from '../../../../shared/types'
import { Label } from '../ui/label'
import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { getExperimentalPaneSearchEntries, getExperimentalSearchEntry } from './experimental-search'
import { HiddenExperimentalGroup } from './HiddenExperimentalGroup'
import { NumberField, SettingsSwitch } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { NativeChatExperimentalSetting } from './NativeChatExperimentalSetting'
import { EphemeralVmsExperimentalSetting } from './EphemeralVmsExperimentalSetting'
import {
  MAX_AGENT_HIBERNATION_IDLE_MS,
  MIN_AGENT_HIBERNATION_IDLE_MS,
  getEffectiveAgentHibernationIdleMs
} from '@/lib/agent-hibernation-planner'

export { getExperimentalPaneSearchEntries }

const MS_PER_MINUTE = 60 * 1000

type ExperimentalPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  /** Hidden-experimental group is only rendered once the user has unlocked
   *  it via Shift-clicking the Experimental sidebar entry. */
  hiddenExperimentalUnlocked?: boolean
}

export function ExperimentalPane({
  settings,
  updateSettings,
  hiddenExperimentalUnlocked = false
}: ExperimentalPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const showPet = matchesSettingsSearch(searchQuery, [getExperimentalSearchEntry().pet])
  const showAgentsView = matchesSettingsSearch(searchQuery, [
    getExperimentalSearchEntry().agentsView
  ])
  const showAgentDashboard = matchesSettingsSearch(searchQuery, [
    getExperimentalSearchEntry().agentDashboard
  ])
  const showNativeChat = matchesSettingsSearch(searchQuery, [
    getExperimentalSearchEntry().nativeChat
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
  const newWorktreeCardStyleEnabled = settings.experimentalNewWorktreeCardStyle === true
  // Why: the planner owns ms-based bounds/defaults; the UI edits minutes
  // while displaying the same effective clamped value the planner will use.
  const agentHibernationIdleMinutes = Math.round(
    getEffectiveAgentHibernationIdleMs(settings.agentHibernationIdleMs) / MS_PER_MINUTE
  )

  return (
    <div className="space-y-4">
      {showPet ? (
        <SearchableSetting
          title={translate('auto.components.settings.ExperimentalPane.dd6f0a1d45', 'Pet')}
          description={translate(
            'auto.components.settings.ExperimentalPane.0e89a574ae',
            'Floating animated pet in the bottom-right corner.'
          )}
          keywords={getExperimentalSearchEntry().pet.keywords}
          className="space-y-3 py-2"
          id="experimental-pet"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-1.5">
              <Label>
                {translate('auto.components.settings.ExperimentalPane.dd6f0a1d45', 'Pet')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.ca2219fe5e',
                  'Shows a small animated pet pinned to the bottom-right corner. Pick a character (Claudino, OpenCode, Gremlin) or upload your own PNG, APNG, GIF, WebP, JPG, or SVG from the status-bar pet menu. Hide it any time from the same menu without disabling this setting.'
                )}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.experimentalPet}
              onClick={() => {
                updateSettings({ experimentalPet: !settings.experimentalPet })
              }}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.experimentalPet ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  settings.experimentalPet ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </SearchableSetting>
      ) : null}

      {showAgentsView ? (
        <SearchableSetting
          title={translate('auto.components.settings.ExperimentalPane.a05bcdaf57', 'Agents View')}
          description={translate(
            'auto.components.settings.ExperimentalPane.f63ea281e3',
            'Threaded left-sidebar feed for agent completions and blocking states.'
          )}
          keywords={getExperimentalSearchEntry().agentsView.keywords}
          className="space-y-3 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {translate('auto.components.settings.ExperimentalPane.a05bcdaf57', 'Agents View')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.0277901cf7',
                  'Adds an Agents entry to the left sidebar with a threaded worktree feed for completed agents, blocking questions, unread state, and worktree creation events. Experimental — the event model and UI may change.'
                )}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.experimentalActivity}
              onClick={() =>
                updateSettings({
                  experimentalActivity: !settings.experimentalActivity
                })
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.experimentalActivity ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  settings.experimentalActivity ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </SearchableSetting>
      ) : null}

      {showAgentDashboard ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.ExperimentalPane.agentDashboard.title',
            'Agent Dashboard'
          )}
          description={translate(
            'auto.components.settings.ExperimentalPane.agentDashboard.description',
            'Pop-out Kanban board for monitoring agents across worktrees.'
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
                  'Adds an Agent Dashboard entry to the left sidebar. Open it to monitor attention, working, and idle agents in a separate window and jump into their live terminals.'
                )}
              </p>
            </div>
            <SettingsSwitch
              checked={settings.experimentalAgentDashboardPopout === true}
              ariaLabel={translate(
                'auto.components.settings.ExperimentalPane.agentDashboard.toggleLabel',
                'Toggle Agent Dashboard'
              )}
              onChange={() =>
                updateSettings({
                  experimentalAgentDashboardPopout:
                    settings.experimentalAgentDashboardPopout !== true
                })
              }
            />
          </div>
        </SearchableSetting>
      ) : null}

      {showNativeChat ? (
        <NativeChatExperimentalSetting settings={settings} updateSettings={updateSettings} />
      ) : null}

      {showTerminalAttention ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.ExperimentalPane.ec897e8d89',
            'Terminal attention'
          )}
          description={translate(
            'auto.components.settings.ExperimentalPane.88b7613afb',
            'Persistent pane highlight for terminal bell and agent-completion events.'
          )}
          keywords={getExperimentalSearchEntry().terminalAttention.keywords}
          className="space-y-3 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {translate(
                  'auto.components.settings.ExperimentalPane.ec897e8d89',
                  'Terminal attention'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.a20d5ea365',
                  'Keeps a pane-level highlight visible after terminal bell or agent-completion events until you interact with that pane. Experimental while we tune the signal.'
                )}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.experimentalTerminalAttention}
              onClick={() =>
                updateSettings({
                  experimentalTerminalAttention: !settings.experimentalTerminalAttention
                })
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.experimentalTerminalAttention ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  settings.experimentalTerminalAttention ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </SearchableSetting>
      ) : null}

      {showAgentHibernation ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.ExperimentalPane.agentHibernation.title',
            'Agent sleep'
          )}
          description={translate(
            'auto.components.settings.ExperimentalPane.agentHibernation.description',
            'Stops idle background agent terminals after the configured idle window and resumes supported sessions when you open them again.'
          )}
          keywords={getExperimentalSearchEntry().agentHibernation.keywords}
          className="space-y-3 py-2"
          id="experimental-agent-hibernation"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {translate(
                  'auto.components.settings.ExperimentalPane.agentHibernation.title',
                  'Agent sleep'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.agentHibernation.copy',
                  'Stops idle background agent terminals after the configured idle window and resumes supported sessions when you open them again. Agent sleep preserves launch options for agents started by Orca. Manually started agents may resume with your current Orca defaults. Experimental while we tune the safety model.'
                )}
              </p>
            </div>
            <SettingsSwitch
              checked={agentHibernationEnabled}
              ariaLabel={translate(
                'auto.components.settings.ExperimentalPane.agentHibernation.toggleLabel',
                'Toggle agent sleep'
              )}
              onChange={() =>
                updateSettings({
                  experimentalAgentHibernation: !agentHibernationEnabled
                })
              }
            />
          </div>
          {agentHibernationEnabled ? (
            <NumberField
              label={translate(
                'auto.components.settings.ExperimentalPane.agentHibernation.idleMinutesLabel',
                'Sleep after'
              )}
              description={translate(
                'auto.components.settings.ExperimentalPane.agentHibernation.idleMinutesDescription',
                'How many idle minutes a completed background agent must wait before Orca can sleep it.'
              )}
              value={agentHibernationIdleMinutes}
              min={MIN_AGENT_HIBERNATION_IDLE_MS / MS_PER_MINUTE}
              max={MAX_AGENT_HIBERNATION_IDLE_MS / MS_PER_MINUTE}
              step={1}
              suffix={translate(
                'auto.components.settings.ExperimentalPane.agentHibernation.idleMinutesSuffix',
                'minutes'
              )}
              onChange={(minutes) =>
                updateSettings({
                  // Why: settings persist the planner contract, not the display unit.
                  agentHibernationIdleMs: minutes * MS_PER_MINUTE
                })
              }
            />
          ) : null}
        </SearchableSetting>
      ) : null}

      {showNewWorktreeCardStyle ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.ExperimentalPane.newWorktreeCardStyle.title',
            'New card style'
          )}
          description={translate(
            'auto.components.settings.ExperimentalPane.newWorktreeCardStyle.description',
            'Preview updated worktree-card layout, metadata placement, card-display menu options, and status presentation.'
          )}
          keywords={getExperimentalSearchEntry().newWorktreeCardStyle.keywords}
          className="space-y-3 py-2"
          id="experimental-new-worktree-card-style"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {translate(
                  'auto.components.settings.ExperimentalPane.newWorktreeCardStyle.title',
                  'New card style'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.newWorktreeCardStyle.copy',
                  'Previews updated worktree-card layout and metadata behavior, including hover/context-menu ownership and status presentation.'
                )}
              </p>
            </div>
            <SettingsSwitch
              checked={newWorktreeCardStyleEnabled}
              ariaLabel={translate(
                'auto.components.settings.ExperimentalPane.newWorktreeCardStyle.toggleLabel',
                'Toggle new card style'
              )}
              onChange={() =>
                updateSettings({
                  experimentalNewWorktreeCardStyle: !newWorktreeCardStyleEnabled
                })
              }
            />
          </div>
        </SearchableSetting>
      ) : null}

      <EphemeralVmsExperimentalSetting settings={settings} updateSettings={updateSettings} />

      {hiddenExperimentalUnlocked ? <HiddenExperimentalGroup /> : null}
    </div>
  )
}
