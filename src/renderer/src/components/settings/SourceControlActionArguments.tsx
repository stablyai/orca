import type { SourceControlActionLaunchPreferences } from '../../../../shared/source-control-ai-actions'
import {
  agentPermissionChoices,
  agentPermissionArgs,
  resolveAgentPermission
} from '../../../../shared/tui-agent-permission-choice'
import { agentArgsSetPermission } from '../../../../shared/tui-agent-permission-lift'
import { liftActionPermissionArgs } from '../../../../shared/source-control-action-permission-lift'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { AgentDefaultArgsInput } from './AgentLaunchDefaultsEditor'
import { AgentPermissionMenu } from './AgentPermissionChoiceControls'

export function SourceControlActionArguments({
  agent,
  value,
  preferences,
  disabled,
  showArguments = true,
  onArgsChange,
  onPreferencesChange
}: {
  agent: TuiAgent | null | undefined
  value: string
  preferences?: SourceControlActionLaunchPreferences
  disabled?: boolean
  showArguments?: boolean
  onArgsChange: (value: string, commit?: boolean) => void
  onPreferencesChange: (value: SourceControlActionLaunchPreferences | undefined) => void
}): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const selected = preferences?.agentId === agent ? preferences : undefined
  const inherited = agent ? resolveAgentPermission(agent, settings).choice : 'own'
  const choice = selected?.permissionMode ?? inherited
  const label = agent ? (AGENT_CATALOG.find((entry) => entry.id === agent)?.label ?? agent) : ''
  const flag = agent && selected?.permissionMode ? agentPermissionArgs(agent, choice) : ''
  const loose = agent ? agentArgsSetPermission(agent, value) : false
  const select = (next: typeof choice | 'default'): void => {
    if (!agent || disabled) {
      return
    }
    const { permissionMode: _previous, ...rest } = selected ?? { agentId: agent }
    onPreferencesChange(
      next !== 'default' ? { ...rest, permissionMode: next } : rest.model ? rest : undefined
    )
  }
  return (
    <>
      {agent ? (
        <div className="min-w-0 flex-1 basis-48 max-w-sm">
          <AgentPermissionMenu
            agentId={agent}
            label={label}
            layout="stacked"
            size="sm"
            disabled={disabled}
            inheritLabel={translate(
              'settings.sourceControl.actionPermissions.sameAsAgent',
              'Same as {{agent}}',
              { agent: label }
            )}
            permission={{
              chatOwnSupported: true,
              choices: agentPermissionChoices(agent),
              choice,
              source: selected?.permissionMode ? 'agent' : 'all',
              defaultChoice: inherited,
              onSelect: select,
              flag,
              argsSetPermission: loose
            }}
          />
        </div>
      ) : null}
      {showArguments ? (
        <div className="w-full min-w-0">
          <AgentDefaultArgsInput
            defaultArgs=""
            argsOverride={value}
            disabled={disabled}
            onDraftChange={(text) => onArgsChange(text)}
            onSaveArgs={(text) => onArgsChange(text, true)}
            permissionChip={
              flag && !loose
                ? {
                    label,
                    flag,
                    removeRecipe: (text) =>
                      agent
                        ? (liftActionPermissionArgs({ agentId: agent, agentArgs: text }, true)
                            .agentArgs ?? null)
                        : null,
                    onRemove: () => select('own')
                  }
                : undefined
            }
            note={
              loose
                ? translate(
                    'settings.agents.permissionArgsTerminalOnly',
                    'These arguments may control {{agent}}’s terminal permissions, so Orca adds no flag. Chats use the Permissions choice above.',
                    { agent: label }
                  )
                : undefined
            }
          />
        </div>
      ) : null}
    </>
  )
}
