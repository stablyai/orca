import { modelMenuOptions } from '../../../../../shared/agent-session/options/model-menu-options'
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
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import {
  agentPickerEntryOptions,
  agentPickerModels
} from '../../../../../shared/agent-launch/picker/agent-launch-picker-catalog'
import { AgentChoiceMenu } from './AgentChoiceMenu'
import { sourceControlActionRouteHint } from './agent-choice-route-hint'
import { useTranslate } from '@/i18n/use-translate'

const AGENT_DEFAULT_VALUE = '__agent_default__'

export type AgentChoiceControlsProps = {
  agent: TuiAgent | null | undefined
  value: AgentDedicatedChoices | undefined
  disabled?: boolean
  onOpenChange?: (open: boolean) => void
  optionIds?: readonly string[]
  defaultLabels?: { model?: string; options?: Record<string, string> }
  layout?: 'stacked' | 'contents' | 'rows'
  /** The host's own list; without a listing the fields keep the release's seed models. */
  liveCatalog?: AgentSessionModelCatalogResult
  /** Tells the reader this list is the release's, because the host gave none. */
  usesSeedModels?: boolean
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
  layout = 'stacked',
  liveCatalog,
  usesSeedModels,
  onSelect
}: Omit<AgentChoiceControlsProps, 'onChange'> & {
  onSelect: (patch: AgentChoicePatch) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const picksModel = sourceControlActionAgentPicksModel(agent)
  if (!agent || !picksModel) {
    return null
  }
  const catalog = picksModel ? getAgentSessionOptionLaunchCatalog(agent) : null
  const selected = value
  const model = catalog && selected?.model ? findCatalogModel(catalog, selected.model) : undefined
  const live =
    liveCatalog && liveCatalog.origin !== 'unknown' && liveCatalog.models.length
      ? { agent, catalog: liveCatalog, terminal: {} }
      : null
  const menu =
    live && catalog && agent !== 'antigravity'
      ? modelMenuOptions(live.catalog, {
          agent,
          surface: 'terminal',
          seed: catalog,
          newLaunch: true,
          seedsModel: false,
          saved: { ...(selected?.model ? { model: selected.model } : {}), ...selected?.options }
        })
      : undefined
  const effort = menu?.descriptors.find(({ id }) => id === 'effort')
  const listedModels = live
    ? (menu?.rows ?? agentPickerModels(live)).filter(({ hidden }) => !hidden)
    : (catalog?.models ?? [])
  const unlistedModel =
    selected?.model && !(live ? listedModels.some(({ id }) => id === selected.model) : model)
      ? selected.model
      : undefined
  const liveEffort = live
    ? agentPickerEntryOptions(live, selected?.model, 'terminal').find(({ id }) => id === 'effort')
    : undefined
  const effortKind =
    menu && selected?.model
      ? effort?.kind.type === 'select'
        ? { ...effort.kind, defaultValue: '' }
        : undefined
      : liveEffort?.kind
  const options = sourceControlActionOptions(agent, selected?.model ?? '').flatMap((row) => {
    // CLI carrier mappings remain available to Args badges without advertising a mode control.
    if (
      (!model && row.option.category === 'mode') ||
      (optionIds && !optionIds.includes(row.option.id))
    ) {
      return []
    }
    if (!live || row.option.id !== 'effort') {
      return [row]
    }
    // A listed model with no reasoning levels gets no effort menu.
    return effortKind ? [{ ...row, option: { ...row.option, kind: effortKind } }] : []
  })
  const defaultLabel = t('settings.sourceControl.actionModel.effortDefault', 'Default')
  return (
    <div className={layout === 'contents' ? 'contents' : 'grid min-w-0 grid-cols-1 gap-2'}>
      {catalog ? (
        <AgentChoiceMenu
          label={t('settings.sourceControl.actionModel.model', 'Model')}
          row={layout === 'rows'}
          value={selected?.model ?? AGENT_DEFAULT_VALUE}
          disabled={disabled}
          onOpenChange={onOpenChange}
          choices={[
            {
              value: AGENT_DEFAULT_VALUE,
              label:
                defaultLabels?.model ??
                t('settings.sourceControl.actionModel.agentDefault', 'Agent default')
            },
            ...listedModels.map(({ id, label }) => ({ value: id, label })),
            ...(unlistedModel ? [{ value: unlistedModel, label: unlistedModel }] : [])
          ]}
          onChange={(model) => onSelect({ model: model === AGENT_DEFAULT_VALUE ? null : model })}
        />
      ) : null}
      {catalog?.models.length && usesSeedModels ? (
        <p data-agent-model-list-fallback className="text-xs text-muted-foreground">
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
