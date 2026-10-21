import type { AgentPermissionMode } from '../../../../shared/tui-agent-permissions'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SettingsBadge, SettingsSegmentedControl } from './SettingsFormControls'
import { agentPermissionModeLabel } from './agent-permission-mode-label'

export type AgentRowPermission = {
  mode: AgentPermissionMode
  /** Mode the global control implies; a different mode is marked as an exception. */
  expectedMode: AgentPermissionMode | null
  autoAvailable: boolean
  onChange: (mode: Exclude<AgentPermissionMode, 'mixed'>) => void
  /** Replaces custom arguments with the expected preset; absent for environment-only agents. */
  reset?: { mode: Exclude<AgentPermissionMode, 'mixed'>; apply: () => void }
}

export function AgentPermissionExceptionBadge({
  label,
  permission,
  onSelect
}: {
  label: string
  permission: AgentRowPermission
  onSelect: () => void
}): React.JSX.Element {
  const { mode } = permission
  const text = mode === 'mixed' ? customLabel() : agentPermissionModeLabel(mode)
  const button = (
    <button
      type="button"
      onClick={onSelect}
      aria-label={translate(
        'settings.agents.editRowPermissions',
        '{{agent}} permissions: {{mode}}',
        {
          agent: label,
          mode: text
        }
      )}
      className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <SettingsBadge tone="accent">{text}</SettingsBadge>
    </button>
  )
  if (mode !== 'mixed') {
    return button
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>
        {translate('settings.agents.customArgsTooltip', 'Uses its own launch arguments.')}
      </TooltipContent>
    </Tooltip>
  )
}

function customLabel(): string {
  return translate('settings.agents.customArgsBadge', 'Custom')
}

export function AgentRowPermissionControl({
  label,
  permission,
  controlRef
}: {
  label: string
  permission: AgentRowPermission
  controlRef: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  return (
    <div ref={controlRef} className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-xs font-medium">
        {translate('settings.agents.rowPermissions', 'Permissions')}
      </span>
      {permission.mode === 'mixed' ? (
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {translate('settings.agents.customPermissions', 'Custom arguments')}
          {permission.reset ? (
            <Button type="button" variant="outline" size="xs" onClick={permission.reset.apply}>
              {translate('settings.agents.replaceWithPermissionMode', 'Replace with {{mode}}', {
                mode: agentPermissionModeLabel(permission.reset.mode)
              })}
            </Button>
          ) : null}
        </span>
      ) : (
        <SettingsSegmentedControl<AgentPermissionMode>
          value={permission.mode}
          onChange={(next) => {
            if (next !== 'mixed') {
              permission.onChange(next)
            }
          }}
          ariaLabel={translate('settings.agents.rowPermissionsLabel', '{{agent}} permissions', {
            agent: label
          })}
          size="sm"
          options={[
            { value: 'manual', label: agentPermissionModeLabel('manual') },
            ...(permission.autoAvailable
              ? [{ value: 'auto' as const, label: agentPermissionModeLabel('auto') }]
              : []),
            { value: 'yolo', label: agentPermissionModeLabel('yolo') }
          ]}
        />
      )}
    </div>
  )
}
