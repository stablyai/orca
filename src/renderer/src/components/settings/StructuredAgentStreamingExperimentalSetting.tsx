import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  normalizeEnabledStructuredMachineAgents,
  STRUCTURED_MACHINE_AGENTS,
  type StructuredMachineAgent
} from '../../../../shared/structured-agent-provider'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch, SettingsSwitchRow } from './SettingsFormControls'
import { getStructuredAgentStreamingExperimentalSearchEntry } from './structured-agent-streaming-experimental-search-entry'

const AGENT_LABELS: Record<StructuredMachineAgent, string> = {
  claude: 'Claude',
  openclaude: 'OpenClaude',
  codex: 'Codex',
  grok: 'Grok',
  omp: 'OMP'
}

export function StructuredAgentStreamingExperimentalSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const enabled = settings.experimentalStructuredNativeChat === true
  const enabledAgents = normalizeEnabledStructuredMachineAgents(
    settings.enabledHarnessStreamingAgents
  )

  const setAgentEnabled = (agent: StructuredMachineAgent, nextEnabled: boolean): void => {
    const selected = new Set(enabledAgents)
    if (nextEnabled) {
      selected.add(agent)
    } else {
      selected.delete(agent)
    }
    updateSettings({
      enabledHarnessStreamingAgents: STRUCTURED_MACHINE_AGENTS.filter((item) => selected.has(item))
    })
  }

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.ExperimentalPane.harnessStreaming.title',
        'Live agent streaming'
      )}
      description={translate(
        'auto.components.settings.ExperimentalPane.harnessStreaming.description',
        'Use structured agent transports for live responses in Chat UI and Rooms.'
      )}
      keywords={getStructuredAgentStreamingExperimentalSearchEntry().keywords}
      className="space-y-3 py-2"
      id="experimental-harness-streaming"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.ExperimentalPane.harnessStreaming.title',
              'Live agent streaming'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.harnessStreaming.copy',
              'New supported sessions use provider APIs for live responses. Existing terminal sessions stay unchanged.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.harnessStreaming.toggleLabel',
            'Toggle live agent streaming'
          )}
          onChange={() => updateSettings({ experimentalStructuredNativeChat: !enabled })}
        />
      </div>
      {enabled ? (
        <div className="ml-4 divide-y divide-border/40 border-l border-border pl-4">
          {STRUCTURED_MACHINE_AGENTS.map((agent) => (
            <SettingsSwitchRow
              key={agent}
              label={AGENT_LABELS[agent]}
              checked={enabledAgents.includes(agent)}
              onChange={() => setAgentEnabled(agent, !enabledAgents.includes(agent))}
            />
          ))}
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.ExperimentalPane.harnessStreaming.liveSteeringLabel',
              'Live steering in rooms'
            )}
            description={translate(
              'auto.components.settings.ExperimentalPane.harnessStreaming.liveSteeringDescription',
              'Steer agent replies into active supported turns. Unsupported deliveries wait privately until the agent is idle.'
            )}
            checked={settings.experimentalRoomLiveSteering === true}
            onChange={() =>
              updateSettings({
                experimentalRoomLiveSteering: settings.experimentalRoomLiveSteering !== true
              })
            }
          />
        </div>
      ) : null}
    </SearchableSetting>
  )
}
