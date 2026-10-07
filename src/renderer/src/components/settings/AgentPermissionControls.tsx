import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { SettingsSegmentedControl, SettingsSubsectionHeader } from './SettingsFormControls'
import type { AgentPermissionMode } from '../../../../shared/tui-agent-permissions'
import type { AgentPermissionException } from './agent-permission-exceptions'

function permissionModeLabel(bypass: boolean): string {
  return bypass
    ? translate('auto.components.settings.AgentsPane.agentPermissionsYolo', 'Yolo')
    : translate('auto.components.settings.AgentsPane.agentPermissionsManual', 'Manual')
}

function exceptionReasonText(exception: AgentPermissionException): string {
  const mode = permissionModeLabel(exception.effectiveBypass)
  const { reason } = exception
  if (reason.kind === 'arguments') {
    return translate(
      'auto.components.settings.AgentsPane.agentPermissionsArgumentsReason',
      'runs {{value0}}: its Arguments set {{value1}}.',
      { value0: mode, value1: reason.options.join(' ') }
    )
  }
  if (reason.kind === 'environment') {
    return translate(
      'auto.components.settings.AgentsPane.agentPermissionsEnvironmentReason',
      'runs {{value0}}: its environment sets {{value1}}.',
      { value0: mode, value1: reason.options.join(' ') }
    )
  }
  return translate(
    'auto.components.settings.AgentsPane.agentPermissionsOwnSettingReason',
    'runs {{value0}}: it has its own setting.',
    { value0: mode }
  )
}

export function AgentPermissionsSetting({
  mode,
  exceptions,
  onChange,
  onRevealException
}: {
  mode: AgentPermissionMode
  exceptions: readonly AgentPermissionException[]
  onChange: (mode: AgentPermissionMode) => void
  onRevealException: (exception: AgentPermissionException) => void
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.AgentsPane.agentPermissions',
          'Agent Permissions'
        )}
        description={
          <>
            {translate(
              'auto.components.settings.AgentsPane.agentPermissionsDescription',
              'Choose whether Orca launches agents with fewer permission prompts or with manual checks.'
            )}{' '}
            {translate(
              'auto.components.settings.AgentsPane.agentPermissionsAppliesToAll',
              'Applies to every agent without its own setting in the list below.'
            )}
            {exceptions.length > 0 ? (
              <span className="mt-1 block">
                {translate(
                  'auto.components.settings.AgentsPane.agentPermissionsNotFollowing',
                  "These agents don't follow this switch:"
                )}
                {exceptions.map((exception) => (
                  <span key={exception.agentId} className="block">
                    {exception.target ? (
                      <Button
                        type="button"
                        variant="link"
                        size="inline"
                        onClick={() => onRevealException(exception)}
                      >
                        {exception.label}
                      </Button>
                    ) : (
                      // Plain text until detection finishes and the row it would open exists.
                      exception.label
                    )}{' '}
                    {exceptionReasonText(exception)}
                  </span>
                ))}
              </span>
            ) : null}
          </>
        }
        action={
          <SettingsSegmentedControl<AgentPermissionMode>
            value={mode}
            onChange={onChange}
            ariaLabel={translate(
              'auto.components.settings.AgentsPane.agentPermissions',
              'Agent Permissions'
            )}
            size="sm"
            options={[
              { value: 'bypass', label: permissionModeLabel(true) },
              { value: 'ask', label: permissionModeLabel(false) }
            ]}
          />
        }
      />
    </section>
  )
}

type AgentPermissionChoice = AgentPermissionMode | 'default'

/** One agent's own permission choice; Default follows the switch. */
export function AgentPermissionOverrideControl({
  agentLabel,
  override,
  defaultMode,
  onChange
}: {
  agentLabel: string
  override: AgentPermissionMode | undefined
  defaultMode: AgentPermissionMode
  onChange: (choice: AgentPermissionChoice) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.settings.AgentsPane.agentPermissionOverride', 'Permissions')}
      </span>
      <SettingsSegmentedControl<AgentPermissionChoice>
        value={override ?? 'default'}
        onChange={onChange}
        ariaLabel={translate(
          'auto.components.settings.AgentsPane.agentPermissionOverrideAria',
          '{{value0}} permissions',
          { value0: agentLabel }
        )}
        size="sm"
        options={[
          {
            value: 'default',
            label: translate(
              'auto.components.settings.AgentsPane.agentPermissionOverrideDefault',
              'Default ({{value0}})',
              { value0: permissionModeLabel(defaultMode === 'bypass') }
            )
          },
          { value: 'bypass', label: permissionModeLabel(true) },
          { value: 'ask', label: permissionModeLabel(false) }
        ]}
      />
    </div>
  )
}
