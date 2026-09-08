import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  supportsTuiAgentAutoPermissionMode,
  type AgentPermissionMode
} from '../../../../shared/tui-agent-permissions'
import { translate } from '@/i18n/i18n'
import { SettingsSegmentedControl, SettingsSubsectionHeader } from './SettingsFormControls'

export function AgentPermissionModeControl({
  mode,
  onChange,
  agent
}: {
  mode: AgentPermissionMode
  onChange: (mode: Exclude<AgentPermissionMode, 'mixed'>) => void
  agent?: TuiAgent
}): React.JSX.Element {
  const disabled = agent !== undefined && mode === 'mixed'
  return (
    <SettingsSegmentedControl<AgentPermissionMode>
      value={mode}
      onChange={(next) => {
        if (next !== 'mixed') {
          onChange(next)
        }
      }}
      ariaLabel={translate(
        'auto.components.settings.AgentsPane.agentPermissions',
        'Agent Permissions'
      )}
      size="sm"
      options={[
        {
          value: 'manual',
          label: translate('auto.components.settings.AgentsPane.agentPermissionsManual', 'Manual'),
          disabled
        },
        ...(!agent || supportsTuiAgentAutoPermissionMode(agent)
          ? [
              {
                value: 'auto' as const,
                label: translate(
                  'auto.components.settings.AgentsPane.agentPermissionsAuto',
                  'Auto'
                ),
                disabled
              }
            ]
          : []),
        {
          value: 'yolo',
          label: translate('auto.components.settings.AgentsPane.agentPermissionsYolo', 'Yolo'),
          disabled
        }
      ]}
    />
  )
}

export function AgentPermissionsSetting({
  mode,
  onChange
}: {
  mode: AgentPermissionMode
  onChange: (mode: Exclude<AgentPermissionMode, 'mixed'>) => void
}): React.JSX.Element {
  return (
    <section className="space-y-2">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.AgentsPane.agentPermissions',
          'Agent Permissions'
        )}
        className="flex-wrap"
        action={<AgentPermissionModeControl mode={mode} onChange={onChange} />}
      />
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.AgentsPane.agentPermissionsModesDescription',
          'Manual asks for approval. Auto uses the agent’s guarded approval mode; agents without Auto use Manual. Yolo skips permission checks.'
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {mode === 'mixed'
          ? translate(
              'auto.components.settings.AgentsPane.agentPermissionsCustom',
              'Custom configuration. Choose a preset to update standard modes; custom launch arguments and environment values are preserved.'
            )
          : translate(
              'auto.components.settings.AgentsPane.agentPermissionsPreserveCustom',
              'Applies to all agents. Custom launch arguments and environment values are preserved.'
            )}
      </p>
    </section>
  )
}
