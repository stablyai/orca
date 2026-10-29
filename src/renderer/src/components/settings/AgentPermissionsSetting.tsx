import { Trans } from 'react-i18next'
import type { AgentPermissionMode } from '../../../../shared/tui-agent-permissions'
import { getIntlLocale, i18n, translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SettingsSegmentedControl } from './SettingsFormControls'
import { agentPermissionModeLabel } from './agent-permission-mode-label'

type PresetMode = Exclude<AgentPermissionMode, 'mixed'>

export type AgentPermissionsSettingProps = {
  mode: AgentPermissionMode
  /** With Auto on: the combined mode of agents Auto doesn't cover. */
  nonAutoMode?: AgentPermissionMode
  /** Most common mode across agents, named when the global state is mixed. */
  majorityMode?: PresetMode | null
  autoAgentLabels?: readonly string[]
  onChange: (mode: PresetMode) => void
  /** Changes only agents Auto doesn't cover. */
  onChangeNonAuto?: (mode: 'manual' | 'yolo') => void
  autoSupported?: boolean
}

function SupportedAgentsTrigger({
  labels,
  children
}: {
  labels: readonly string[]
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="cursor-help rounded-sm underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" sideOffset={6}>
        {new Intl.ListFormat(getIntlLocale(), { type: 'conjunction' }).format(labels)}
      </TooltipContent>
    </Tooltip>
  )
}

function AgentPermissionsDescription({
  mode,
  majorityMode,
  autoAgentLabels
}: AgentPermissionsSettingProps): React.ReactNode {
  if (mode === 'auto') {
    return (
      <Trans
        i18n={i18n}
        defaults={translate(
          'settings.agents.permissionsAutoDescription',
          '<agents>Supported agents</agents> approve safe actions on their own.'
        )}
        components={{ agents: <SupportedAgentsTrigger labels={autoAgentLabels ?? []} /> }}
      />
    )
  }
  if (mode === 'mixed') {
    return majorityMode
      ? translate(
          'settings.agents.permissionsMixed',
          'Most agents use {{mode}}. Choosing a mode resets the marked exceptions, except custom arguments.',
          { mode: agentPermissionModeLabel(majorityMode) }
        )
      : translate(
          'settings.agents.permissionsMixedNoMajority',
          'Agents use different settings. Choosing a mode applies to all.'
        )
  }
  return translate(
    'settings.agents.permissionsDescription',
    'How much agents can do without asking you. Agents with custom launch arguments keep them.'
  )
}

export function AgentPermissionsSetting(props: AgentPermissionsSettingProps): React.JSX.Element {
  const { mode, nonAutoMode, onChange, onChangeNonAuto, autoSupported = true } = props
  const title = translate(
    'auto.components.settings.AgentsPane.agentPermissions',
    'Agent Permissions'
  )
  const showOthers = mode === 'auto' && onChangeNonAuto !== undefined
  return (
    <section className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">
          <AgentPermissionsDescription {...props} />
        </p>
        {!autoSupported ? (
          <p className="text-xs text-muted-foreground">
            {translate('settings.agents.autoUnsupported', 'Auto needs a newer Orca on this host.')}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <SettingsSegmentedControl<AgentPermissionMode>
          value={mode}
          onChange={(next) => {
            if (next !== 'mixed') {
              onChange(next)
            }
          }}
          ariaLabel={title}
          size="sm"
          options={[
            { value: 'manual', label: agentPermissionModeLabel('manual') },
            { value: 'auto', label: agentPermissionModeLabel('auto'), disabled: !autoSupported },
            { value: 'yolo', label: agentPermissionModeLabel('yolo') }
          ]}
        />
        {/* Keep mounted for animation; inert excludes hidden controls from focus and accessibility. */}
        <div
          inert={!showOthers}
          aria-hidden={!showOthers}
          className={cn(
            'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
            showOthers ? 'grid-rows-[1fr]' : 'grid-rows-[0fr] delay-100'
          )}
        >
          <div className="min-h-0 overflow-hidden">
            {/* Fade after opening and before closing so content never appears half-clipped. */}
            <div
              className={cn(
                'flex items-center gap-2 whitespace-nowrap pt-1.5 transition-[opacity,translate] ease-out motion-reduce:transition-none',
                showOthers
                  ? 'translate-y-0 opacity-100 delay-100 duration-150'
                  : '-translate-y-1 opacity-0 duration-100'
              )}
            >
              <span className="text-xs text-muted-foreground">
                {translate('settings.agents.otherAgentsPermissions', 'Other agents')}
              </span>
              <SettingsSegmentedControl<AgentPermissionMode>
                value={nonAutoMode ?? 'mixed'}
                onChange={(next) => {
                  if ((next === 'manual' || next === 'yolo') && onChangeNonAuto) {
                    onChangeNonAuto(next)
                  }
                }}
                ariaLabel={translate(
                  'settings.agents.otherAgentsPermissionsLabel',
                  'Permissions for other agents'
                )}
                size="sm"
                options={[
                  { value: 'manual', label: agentPermissionModeLabel('manual') },
                  { value: 'yolo', label: agentPermissionModeLabel('yolo') }
                ]}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
