import {
  modelCatalogChoiceEdit,
  type ModelCatalogSource
} from '../../../../../shared/agent-session/options/model-catalog-source'
import type { modelMenuOptions } from '../../../../../shared/agent-session/options/model-menu-options'
import type {
  AgentChoicePatch,
  AgentDedicatedChoices
} from '../../../../../shared/agent-launch/choices/agent-launch-choices'
import { reconcileAgentChoiceArgs } from '../../../../../shared/agent-launch/choices/agent-choice-reconciliation'
import {
  findCatalogModel,
  getAgentSessionOptionLaunchCatalog
} from '../../../../../shared/agent-session/options/agent-session-option-catalog'
import {
  sourceControlActionAgentPicksModel,
  sourceControlActionOptions
} from '../../../../../shared/source-control/ai/recipes/source-control-action-options'
import { encodeCatalogOptionValue } from '../../../../../shared/agent-session/options/structured-agent-session-option-codec'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { AgentChoiceMenu } from './AgentChoiceMenu'
import { sourceControlActionRouteHint } from './agent-choice-route-hint'
import { useTranslate } from '@/i18n/use-translate'

const AGENT_DEFAULT_VALUE = '__agent_default__'

export type AgentChoiceControlsProps = {
  agent: TuiAgent | null | undefined
  value: AgentDedicatedChoices | undefined
  modelMenu?: ReturnType<typeof modelMenuOptions> & {
    fallbackAfterFailure?: boolean
    source?: ModelCatalogSource
  }
  disabled?: boolean
  onOpenChange?: (open: boolean) => void
  optionIds?: readonly string[]
  defaultLabels?: { model?: string; options?: Record<string, string> }
  layout?: 'stacked' | 'contents' | 'rows'
  onChange: (value: AgentDedicatedChoices | undefined) => void
}

export function AgentChoiceControls(props: AgentChoiceControlsProps): React.JSX.Element | null {
  return (
    <AgentChoiceFields
      {...props}
      onSelect={(patch) => {
        if (!props.agent) {
          return
        }
        props.onChange(
          reconcileAgentChoiceArgs({
            agent: props.agent,
            choices: props.value ?? {},
            userArgs: '',
            mode: 'choice-edit',
            keys: new Set(['model', ...Object.keys(patch.options ?? {})]),
            patch
          }).choices
        )
      }}
    />
  )
}

export function AgentChoiceFields({
  agent,
  value,
  disabled,
  onOpenChange,
  optionIds,
  defaultLabels,
  modelMenu,
  layout = 'stacked',
  onSelect
}: Omit<AgentChoiceControlsProps, 'onChange'> & {
  onSelect: (patch: AgentChoicePatch) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const picksModel = sourceControlActionAgentPicksModel(agent)
  if (!agent || !picksModel) {
    return null
  }
  const catalog = modelMenu?.catalog ?? getAgentSessionOptionLaunchCatalog(agent)
  const selected = value
  const model = selected?.model
    ? modelMenu
      ? modelMenu.rows.find((row) => row.id === selected.model)
      : catalog && findCatalogModel(catalog, selected.model)
    : undefined
  const unlistedModel = catalog && selected?.model && !model ? selected.model : undefined
  let options = sourceControlActionOptions(agent, selected?.model ?? '').filter(
    // CLI carrier mappings remain available to Args badges without advertising a mode control.
    ({ option }) =>
      (Boolean(model) || option.category !== 'mode') &&
      (!optionIds || optionIds.includes(option.id))
  )
  const effort = modelMenu?.descriptors.find((entry) => entry.id === 'effort')
  const modelDescriptor = modelMenu?.descriptors.find((entry) => entry.id === 'model')
  if (modelMenu && selected?.model) {
    options = options.filter(({ option }) => option.id !== 'effort')
    if (effort?.kind.type === 'select') {
      options.push({
        option: {
          id: 'effort',
          label: effort.label,
          category: effort.category,
          kind: { type: 'select', choices: effort.kind.choices, defaultValue: '' },
          apply: {}
        },
        route: null
      })
    }
  }
  const defaultLabel = t('settings.sourceControl.actionModel.effortDefault', 'Default')
  return (
    <div className={layout === 'contents' ? 'contents' : 'grid min-w-0 grid-cols-1 gap-2'}>
      {catalog ? (
        <AgentChoiceMenu
          label={t('settings.sourceControl.actionModel.model', 'Model')}
          row={layout === 'rows'}
          value={selected?.model ?? AGENT_DEFAULT_VALUE}
          disabled={disabled}
          pendingLabel={
            modelMenu?.status === 'listing' && modelDescriptor
              ? (selected?.model ?? t('settings.sourceControl.actionModel.model', 'Model'))
              : undefined
          }
          onOpenChange={onOpenChange}
          choices={[
            {
              value: AGENT_DEFAULT_VALUE,
              label:
                defaultLabels?.model ??
                t('settings.sourceControl.actionModel.agentDefault', 'Agent default')
            },
            ...(modelMenu ? modelMenu.rows : catalog.models).map(({ id, label }) => ({
              value: id,
              label
            })),
            ...(unlistedModel ? [{ value: unlistedModel, label: unlistedModel }] : [])
          ]}
          onChange={(model) => {
            const patch = { model: model === AGENT_DEFAULT_VALUE ? null : model }
            onSelect(
              modelCatalogChoiceEdit(
                modelMenu?.source ?? 'structured',
                modelMenu?.rows ?? [],
                selected?.model,
                patch
              )
            )
          }}
        />
      ) : null}
      {modelMenu?.fallbackAfterFailure ? (
        <p role="note" className="text-xs text-muted-foreground">
          {t(
            'settings.agents.modelListFallback',
            'Built-in list. Orca could not get a model list from this host.'
          )}
        </p>
      ) : null}
      {options.map(({ option, route }) => {
        const choices =
          option.kind.type === 'select'
            ? option.kind.choices
            : [
                {
                  value: 'true',
                  label: t('settings.sourceControl.actionModel.on', 'On')
                },
                {
                  value: 'false',
                  label: t('settings.sourceControl.actionModel.off', 'Off')
                }
              ]
        const current = selected?.options?.[option.id]
        return (
          <AgentChoiceMenu
            key={option.id}
            label={option.label}
            row={layout === 'rows'}
            hint={sourceControlActionRouteHint(route, t)}
            value={current ?? AGENT_DEFAULT_VALUE}
            disabled={disabled || (option.id === 'effort' && effort?.settable === false)}
            onOpenChange={onOpenChange}
            choices={[
              {
                value: AGENT_DEFAULT_VALUE,
                label: defaultLabels?.options?.[option.id] ?? defaultLabel
              },
              ...choices,
              ...(current && !choices.some((choice) => choice.value === current)
                ? [{ value: current, label: current }]
                : [])
            ]}
            onChange={(next) => {
              const encoded =
                next === AGENT_DEFAULT_VALUE
                  ? null
                  : encodeCatalogOptionValue(
                      option.kind,
                      option.kind.type === 'boolean' ? next === 'true' : next
                    )
              onSelect({ options: { [option.id]: encoded } })
            }}
          />
        )
      })}
    </div>
  )
}
