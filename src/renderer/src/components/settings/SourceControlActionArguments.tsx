import { resolveAgentChoiceLayers } from '../../../../shared/agent-choice-layers'
import {
  findCatalogModel,
  getAgentSessionOptionLaunchCatalog
} from '../../../../shared/agent-session-option-catalog'
import { sourceControlActionOptions } from '../../../../shared/source-control-action-launch-preferences'
import { agentModelChoiceChips } from './agent-model-choice-chips'
import type {
  SourceControlActionLaunchPreferences,
  SourceControlActionRecipe
} from '../../../../shared/source-control-ai-actions'
import {
  agentPermissionArgs,
  agentPermissionChoices,
  resolveAgentPermission
} from '../../../../shared/tui-agent-permission-choice'
import { agentArgsSetPermission } from '../../../../shared/tui-agent-permission-lift'
import {
  editActionArgumentChoices,
  type ActionArgumentChoices
} from '../../../../shared/source-control-action-argument-choices'
import type { AgentChoicePatch, AgentLaunchChoices } from '../../../../shared/agent-launch-choices'
import { SourceControlActionModelPicker } from './SourceControlActionModelPicker'
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
  authoredPreferences,
  authoredAgent,
  modelSelectionBase = 'default',
  argumentChoices,
  agentLaunchChoices,
  placeholder,
  disabled,
  showArguments = true,
  onArgsChange,
  onPreferencesChange
}: {
  agent: TuiAgent | null | undefined
  value: string | null | undefined
  preferences?: SourceControlActionLaunchPreferences
  authoredPreferences?: SourceControlActionLaunchPreferences | null
  authoredAgent?: SourceControlActionRecipe['agentId']
  modelSelectionBase?: 'inherit' | 'default'
  argumentChoices?: ActionArgumentChoices
  agentLaunchChoices?: AgentLaunchChoices | null
  placeholder?: string
  disabled?: boolean
  showArguments?: boolean
  onArgsChange: (value: string, commit?: boolean) => void
  onPreferencesChange: (
    value: SourceControlActionLaunchPreferences | undefined,
    userArgs?: string,
    argumentChoices?: ActionArgumentChoices | null
  ) => void
}): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const defaults =
    agentLaunchChoices === undefined ? settings?.agentLaunchChoices : agentLaunchChoices
  const selected = preferences?.agentId === agent ? preferences : undefined
  const inherited = agent ? resolveAgentPermission(agent, settings).choice : 'own'
  const choice = selected?.permissionMode ?? inherited
  const label = agent ? (AGENT_CATALOG.find((entry) => entry.id === agent)?.label ?? agent) : ''
  const flag = agent && selected?.permissionMode ? agentPermissionArgs(agent, choice) : ''
  const loose = agent ? agentArgsSetPermission(agent, value ?? '') : false
  const commit = (patch: AgentChoicePatch, text = value ?? ''): string => {
    if (!agent || disabled) {
      return text
    }
    const changed =
      (patch.model !== undefined && (patch.model ?? undefined) !== selected?.model) ||
      Object.entries(patch.options ?? {}).some(
        ([key, next]) => (next ?? undefined) !== selected?.options?.[key]
      ) ||
      (patch.permissionMode !== undefined &&
        (patch.permissionMode === 'default' ? undefined : patch.permissionMode) !==
          selected?.permissionMode)
    if (!changed) {
      return text
    }
    const result = editActionArgumentChoices(
      {
        agentId: authoredAgent ?? argumentChoices?.syntaxAgent,
        agentArgs: value ?? undefined,
        argumentChoices,
        launchPreferences:
          authoredPreferences === undefined ? preferences : (authoredPreferences ?? undefined)
      },
      agent,
      selected ?? {},
      patch,
      text,
      value === undefined ? modelSelectionBase : 'default'
    )
    onPreferencesChange(
      result.launchPreferences,
      result.agentArgs !== (value ?? '') ? result.agentArgs : undefined,
      result.argumentChoices ?? null
    )
    return result.agentArgs ?? text
  }
  const select = (permissionMode: typeof choice | 'default'): void => {
    commit({ permissionMode })
  }
  const chips = agentModelChoiceChips(
    agent,
    label,
    loose && selected ? { ...selected, permissionMode: undefined } : selected,
    commit
  )
  const { effort: _currentEffort, ...resetOptions } = selected?.options ?? {}
  const defaultChoices = agent
    ? resolveAgentChoiceLayers({
        agent,
        defaults: defaults?.[agent],
        action: { ...selected, options: resetOptions },
        argumentOwner: 'launch',
        userArgs: value
      })
    : undefined
  const effort = agent
    ? sourceControlActionOptions(agent, defaultChoices?.model ?? '').find(
        ({ option }) => option.id === 'effort'
      )?.option
    : undefined
  const effortLabel =
    effort?.kind.type === 'select'
      ? effort.kind.choices.find((choice) => choice.value === defaultChoices?.options?.effort)
          ?.label
      : undefined
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
      {agent ? (
        <SourceControlActionModelPicker
          agent={agent}
          value={selected}
          defaultLabels={
            defaults != null
              ? {
                  model: translate(
                    'settings.agents.sameAsChoice',
                    'Same as {{agent}} · {{choice}}',
                    {
                      agent: label,
                      choice: defaults[agent]?.model
                        ? (findCatalogModel(
                            getAgentSessionOptionLaunchCatalog(agent) ?? {
                              models: [],
                              modelApply: {}
                            },
                            defaults[agent]?.model ?? ''
                          )?.label ?? defaults[agent]?.model)
                        : translate(
                            'settings.sourceControl.actionModel.agentDefault',
                            'Agent default'
                          )
                    }
                  ),
                  options: {
                    effort: translate(
                      'settings.agents.sameAsChoice',
                      'Same as {{agent}} · {{choice}}',
                      {
                        agent: label,
                        choice:
                          effortLabel ??
                          defaultChoices?.options?.effort ??
                          translate('settings.sourceControl.actionModel.effortDefault', 'Default')
                      }
                    )
                  }
                }
              : undefined
          }
          disabled={disabled}
          layout="contents"
          onChange={(next) =>
            commit({
              ...(next?.model !== selected?.model ? { model: next?.model ?? null } : {}),
              options: Object.fromEntries(
                [
                  ...new Set([
                    ...Object.keys(selected?.options ?? {}),
                    ...Object.keys(next?.options ?? {})
                  ])
                ]
                  .filter(
                    (key) =>
                      next?.model === selected?.model &&
                      next?.options?.[key] !== selected?.options?.[key]
                  )
                  .map((key) => [key, next?.options?.[key] ?? null])
              )
            })
          }
        />
      ) : null}
      {showArguments ? (
        <div className="w-full min-w-0">
          <AgentDefaultArgsInput
            defaultArgs=""
            placeholder={placeholder}
            onResetArgs={
              argumentChoices
                ? () =>
                    onPreferencesChange(
                      authoredPreferences === undefined
                        ? preferences
                        : (authoredPreferences ?? undefined),
                      '',
                      null
                    )
                : undefined
            }
            argsOverride={value ?? ''}
            disabled={disabled}
            onDraftChange={(text) => onArgsChange(text)}
            onSaveArgs={(text) => {
              // Unedited inherited or cleared arguments must not become an authored empty override.
              if (value != null || text !== '') {
                onArgsChange(text, true)
              }
            }}
            choiceChips={chips}
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
