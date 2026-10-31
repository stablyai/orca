import { useRef, useState, type Ref } from 'react'
import {
  AGENT_LAUNCH_CHOICE_KEYS,
  type AgentModelOptionChoices,
  type AgentChoicePatch,
  type AgentDedicatedChoices
} from '../../../../shared/agent-launch-choices'
import { AgentDefaultArgsInput } from './AgentLaunchDefaultsEditor'
import { AgentPermissionMenu, type AgentPermissionChoiceRow } from './AgentPermissionChoiceControls'
import { agentModelChoiceChips } from './agent-model-choice-chips'
import { useAgentLaunchFieldWrite } from './use-agent-launch-field-write'
import { reconcileAgentChoiceArgs } from '../../../../shared/agent-choice-reconciliation'
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
import { AgentChoiceMenu } from './AgentChoiceMenu'
import { sourceControlActionRouteHint } from './SourceControlActionOptionField'
import { translate } from '@/i18n/i18n'

const AGENT_DEFAULT_VALUE = '__agent_default__'

export type AgentChoiceControlsProps = {
  agent: TuiAgent | null | undefined
  value: AgentDedicatedChoices | undefined
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

function AgentChoiceFields({
  agent,
  value,
  disabled,
  onOpenChange,
  optionIds,
  defaultLabels,
  layout = 'stacked',
  onSelect
}: Omit<AgentChoiceControlsProps, 'onChange'> & {
  onSelect: (patch: AgentChoicePatch) => void
}): React.JSX.Element | null {
  const picksModel = sourceControlActionAgentPicksModel(agent)
  if (!agent || !picksModel) {
    return null
  }
  const catalog = picksModel ? getAgentSessionOptionLaunchCatalog(agent) : null
  const selected = value
  const model = catalog && selected?.model ? findCatalogModel(catalog, selected.model) : undefined
  const unlistedModel = catalog && selected?.model && !model ? selected.model : undefined
  const options = sourceControlActionOptions(agent, selected?.model ?? '').filter(
    // CLI carrier mappings remain available to Args badges without advertising a mode control.
    ({ option }) =>
      (Boolean(model) || option.category !== 'mode') &&
      (!optionIds || optionIds.includes(option.id))
  )
  const defaultLabel = translate('settings.sourceControl.actionModel.effortDefault', 'Default')
  return (
    <div className={layout === 'contents' ? 'contents' : 'grid min-w-0 grid-cols-1 gap-2'}>
      {catalog ? (
        <AgentChoiceMenu
          label={translate('settings.sourceControl.actionModel.model', 'Model')}
          row={layout === 'rows'}
          value={selected?.model ?? AGENT_DEFAULT_VALUE}
          disabled={disabled}
          onOpenChange={onOpenChange}
          choices={[
            {
              value: AGENT_DEFAULT_VALUE,
              label:
                defaultLabels?.model ??
                translate('settings.sourceControl.actionModel.agentDefault', 'Agent default')
            },
            ...catalog.models.map(({ id, label }) => ({ value: id, label })),
            ...(unlistedModel ? [{ value: unlistedModel, label: unlistedModel }] : [])
          ]}
          onChange={(model) => onSelect({ model: model === AGENT_DEFAULT_VALUE ? null : model })}
        />
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
          <AgentChoiceMenu
            key={option.id}
            label={option.label}
            row={layout === 'rows'}
            hint={sourceControlActionRouteHint(route)}
            value={current ?? AGENT_DEFAULT_VALUE}
            disabled={disabled}
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

export function AgentLaunchChoiceEditor({
  agent,
  label,
  choices,
  userArgs,
  permission,
  permissionControlRef,
  save,
  showArguments = true
}: {
  showArguments?: boolean
  agent: TuiAgent
  label: string
  choices: AgentModelOptionChoices | undefined
  userArgs: string
  permission: AgentPermissionChoiceRow | undefined
  permissionControlRef?: Ref<HTMLDivElement>
  save: (patch: AgentChoicePatch | undefined, userArgs: string) => Promise<void>
}): React.JSX.Element {
  const menu = useRef({ open: false, committed: false })
  const editorRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? userArgs
  const { pending, write } = useAgentLaunchFieldWrite()
  const saveArgs = (raw: string): void => {
    if (raw === userArgs.trim()) {
      setDraft(null)
      return
    }
    write(
      JSON.stringify([null, raw]),
      () => save(undefined, raw),
      () => setDraft((current) => (current === raw ? null : current))
    )
  }
  const onOpenChange = (open: boolean): void => {
    if (!open && !menu.current.committed) {
      saveArgs(text.trim())
    }
    menu.current = { open, committed: false }
  }
  const commit = (patch: AgentChoicePatch, raw = text): string => {
    menu.current.committed = true
    const result = reconcileAgentChoiceArgs({
      agent,
      choices: { ...choices, permissionMode: permission?.choice },
      userArgs: raw,
      mode: 'choice-edit',
      keys: AGENT_LAUNCH_CHOICE_KEYS,
      patch
    })
    setDraft(raw)
    write(
      JSON.stringify([patch, raw]),
      () => save(patch, raw),
      () => setDraft((current) => (current === raw ? null : current))
    )
    return result.userArgs
  }
  const chips = agentModelChoiceChips(
    agent,
    label,
    {
      ...choices,
      ...(!permission?.argsSetPermission && permission?.choice
        ? { permissionMode: permission.choice }
        : {})
    },
    commit
  )
  return (
    <div
      ref={editorRef}
      className="space-y-3"
      onBlur={(event) => {
        if (!menu.current.open && !event.currentTarget.contains(event.relatedTarget)) {
          saveArgs(text.trim())
        }
      }}
    >
      <div className="space-y-2">
        <AgentChoiceFields
          agent={agent}
          value={choices}
          disabled={pending}
          layout="rows"
          onOpenChange={onOpenChange}
          optionIds={['effort']}
          onSelect={(patch) => commit(patch)}
        />
        {permission ? (
          <div ref={permissionControlRef}>
            <AgentPermissionMenu
              agentId={agent}
              label={label}
              layout="row"
              disabled={pending}
              onOpenChange={onOpenChange}
              permission={{
                ...permission,
                onSelect: (permissionMode) => commit({ permissionMode })
              }}
            />
          </div>
        ) : null}
      </div>
      {showArguments ? (
        <AgentDefaultArgsInput
          defaultArgs=""
          argsOverride={text}
          disabled={pending}
          onDraftChange={setDraft}
          containsFocus={(target) =>
            menu.current.open ||
            (target instanceof Node && Boolean(editorRef.current?.contains(target)))
          }
          onDiscardArgs={() => setDraft(null)}
          choiceChips={chips}
          note={
            permission?.argsSetPermission
              ? translate(
                  'settings.agents.permissionArgsTerminalOnly',
                  'These arguments may control {{agent}}’s terminal permissions, so Orca adds no flag. Chats use the Permissions choice above.',
                  { agent: label }
                )
              : undefined
          }
          onSaveArgs={saveArgs}
        />
      ) : null}
    </div>
  )
}
