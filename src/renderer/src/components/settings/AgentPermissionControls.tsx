import { Info, TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SettingsSegmentedControl, SettingsSubsectionHeader } from './SettingsFormControls'
import type { AgentPermissionMode } from '../../../../shared/tui-agent-permissions'
import type { AgentPermissionPosture } from '../../../../shared/tui-agent-permission-args'

/** An agent whose launch posture differs from the shared default. */
export type AgentPermissionException = { label: string; effectiveBypass: boolean }

function permissionModeLabel(bypass: boolean): string {
  return bypass
    ? translate('auto.components.settings.AgentsPane.agentPermissionsYolo', 'Yolo')
    : translate('auto.components.settings.AgentsPane.agentPermissionsManual', 'Manual')
}

export function AgentPermissionsSetting({
  mode,
  exceptions,
  onChange
}: {
  mode: AgentPermissionMode
  exceptions: readonly AgentPermissionException[]
  onChange: (mode: AgentPermissionMode) => void
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={
          <span className="flex items-center gap-2">
            {translate('auto.components.settings.AgentsPane.agentPermissions', 'Agent Permissions')}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={translate(
                    'auto.components.settings.AgentsPane.agentPermissionsInfo',
                    'Agent permissions info'
                  )}
                  className="grid size-5 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <Info className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {translate(
                  'auto.components.settings.AgentsPane.agentPermissionsAppliesToAll',
                  'Applies to every agent. To set one agent differently, expand it in the list below.'
                )}
              </TooltipContent>
            </Tooltip>
          </span>
        }
        description={
          <>
            {translate(
              'auto.components.settings.AgentsPane.agentPermissionsDescription',
              'Choose whether Orca launches agents with fewer permission prompts or with manual checks.'
            )}
            {exceptions.length > 0 ? (
              <span className="mt-1 block">
                {translate(
                  'auto.components.settings.AgentsPane.agentPermissionsExceptions',
                  'Set separately: {{value0}}.',
                  {
                    value0: exceptions
                      .map(
                        (exception) =>
                          `${exception.label} (${permissionModeLabel(exception.effectiveBypass)})`
                      )
                      .join(', ')
                  }
                )}
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

/** One agent's permission choice, and what its typed Arguments do to it. */
export function AgentPermissionOverrideControl({
  agentLabel,
  override,
  defaultMode,
  posture,
  onChange
}: {
  agentLabel: string
  override: AgentPermissionMode | undefined
  defaultMode: AgentPermissionMode
  posture: AgentPermissionPosture
  onChange: (choice: AgentPermissionChoice) => void
}): React.JSX.Element {
  const notice =
    posture.typedPermissionOptions.length > 0
      ? translate(
          'auto.components.settings.AgentsPane.agentPermissionArgumentsOptions',
          'Arguments or environment set permissions themselves ({{value0}}), so {{value1}} uses them instead of this setting.',
          { value0: posture.typedPermissionOptions.join(' '), value1: agentLabel }
        )
      : null
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
      {notice ? (
        <div className="flex items-start gap-2 self-stretch rounded-md border border-status-warning-border bg-status-warning-background px-2.5 py-1.5 text-status-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <p className="min-w-0 text-xs leading-snug">{notice}</p>
        </div>
      ) : null}
    </div>
  )
}
