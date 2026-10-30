import { reconcileAgentChoiceArgs } from '../../../../shared/agent-choice-reconciliation'
import {
  normalizeAgentModelOptionChoices,
  type AgentDedicatedChoices
} from '../../../../shared/agent-launch-choices'
import {
  findCatalogModel,
  getAgentSessionOptionLaunchCatalog
} from '../../../../shared/agent-session-option-catalog'
import type { SourceControlActionLaunchPreferences } from '../../../../shared/source-control-ai-actions'
import {
  sourceControlActionAgentPicksModel,
  sourceControlActionOptions
} from '../../../../shared/source-control-action-launch-preferences'
import { encodeCatalogOptionValue } from '../../../../shared/structured-agent-session-option-codec'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { Select, SelectContent, SelectItem } from '../ui/select'
import {
  SourceControlActionOptionField,
  SourceControlActionOptionTrigger,
  sourceControlActionRouteHint
} from './SourceControlActionOptionField'
import { translate } from '@/i18n/i18n'

const AGENT_DEFAULT_VALUE = '__agent_default__'

export type AgentChoiceControlsProps = {
  agent: TuiAgent | null | undefined
  value: AgentDedicatedChoices | undefined
  disabled?: boolean
  layout?: 'stacked' | 'contents'
  onChange: (value: AgentDedicatedChoices | undefined) => void
}

export function AgentChoiceControls({
  agent,
  value,
  disabled,
  layout = 'stacked',
  onChange
}: AgentChoiceControlsProps): React.JSX.Element | null {
  const picksModel = sourceControlActionAgentPicksModel(agent)
  if (!agent || !picksModel) {
    return null
  }
  const catalog = picksModel ? getAgentSessionOptionLaunchCatalog(agent) : null
  const selected = value
  // Model and permission mode are saved independently; a model change keeps the mode.
  const save = (next: AgentDedicatedChoices): void =>
    onChange({
      ...normalizeAgentModelOptionChoices(next),
      ...(next.permissionMode ? { permissionMode: next.permissionMode } : {})
    })
  const unlistedModel =
    catalog && selected?.model && !findCatalogModel(catalog, selected.model)
      ? selected.model
      : undefined
  const options = sourceControlActionOptions(agent, selected?.model ?? '')
  const defaultLabel = translate('settings.sourceControl.actionModel.effortDefault', 'Default')
  return (
    <div className={layout === 'contents' ? 'contents' : 'grid min-w-0 grid-cols-1 gap-2'}>
      {catalog ? (
        <SourceControlActionOptionField
          label={translate('settings.sourceControl.actionModel.model', 'Model')}
        >
          <Select
            value={selected?.model ?? AGENT_DEFAULT_VALUE}
            disabled={disabled}
            onValueChange={(model) =>
              onChange(
                reconcileAgentChoiceArgs({
                  agent,
                  choices: selected ?? {},
                  userArgs: '',
                  mode: 'choice-edit',
                  keys: new Set(['model']),
                  patch: { model: model === AGENT_DEFAULT_VALUE ? null : model }
                }).choices
              )
            }
          >
            <SourceControlActionOptionTrigger
              disabled={disabled}
              label={
                selected?.model
                  ? (findCatalogModel(catalog, selected.model)?.label ?? selected.model)
                  : translate('settings.sourceControl.actionModel.agentDefault', 'Agent default')
              }
            />
            <SelectContent>
              <SelectItem value={AGENT_DEFAULT_VALUE}>
                {translate('settings.sourceControl.actionModel.agentDefault', 'Agent default')}
              </SelectItem>
              {catalog.models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.label}
                </SelectItem>
              ))}
              {unlistedModel ? (
                <SelectItem value={unlistedModel}>{unlistedModel}</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </SourceControlActionOptionField>
      ) : null}
      {options.map(({ option, route }) => {
        const choices =
          option.kind.type === 'select'
            ? option.kind.choices
            : [
                {
                  value: 'true',
                  label: translate('settings.sourceControl.actionModel.on', 'On')
                },
                {
                  value: 'false',
                  label: translate('settings.sourceControl.actionModel.off', 'Off')
                }
              ]
        const current = selected?.options?.[option.id]
        return (
          <SourceControlActionOptionField
            key={option.id}
            label={option.label}
            hint={sourceControlActionRouteHint(route)}
          >
            <Select
              value={current ?? AGENT_DEFAULT_VALUE}
              disabled={disabled}
              onValueChange={(next) => {
                const { [option.id]: _old, ...rest } = selected?.options ?? {}
                const encoded =
                  next === AGENT_DEFAULT_VALUE
                    ? null
                    : encodeCatalogOptionValue(
                        option.kind,
                        option.kind.type === 'boolean' ? next === 'true' : next
                      )
                const values = {
                  ...rest,
                  ...(encoded === null ? {} : { [option.id]: encoded })
                }
                save({ ...selected, options: values })
              }}
            >
              <SourceControlActionOptionTrigger
                disabled={disabled}
                label={
                  current
                    ? (choices.find((choice) => choice.value === current)?.label ?? current)
                    : defaultLabel
                }
              />
              <SelectContent>
                <SelectItem value={AGENT_DEFAULT_VALUE}>{defaultLabel}</SelectItem>
                {choices.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
                {current && !choices.some((choice) => choice.value === current) ? (
                  <SelectItem value={current}>{current}</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </SourceControlActionOptionField>
        )
      })}
    </div>
  )
}

export function SourceControlActionModelPicker(
  props: Omit<AgentChoiceControlsProps, 'value' | 'onChange'> & {
    value: SourceControlActionLaunchPreferences | undefined
    onChange: (value: SourceControlActionLaunchPreferences | undefined) => void
  }
): React.JSX.Element {
  return (
    <AgentChoiceControls
      {...props}
      value={props.value?.agentId === props.agent ? props.value : undefined}
      onChange={(value) =>
        props.onChange(
          props.agent && value && Object.keys(value).length
            ? { agentId: props.agent, ...value }
            : undefined
        )
      }
    />
  )
}
