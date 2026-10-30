import { useState } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight, CornerDownLeft } from 'lucide-react'
import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session-option-catalog'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import { AgentDefaultArgsInput } from '../settings/AgentLaunchDefaultsEditor'
import { NativeChatSessionOptionRows } from '../native-chat/NativeChatSessionOptionRows'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import { AgentPermissionMenu } from '../settings/AgentPermissionChoiceControls'
import {
  agentPickerPanelArguments,
  agentPickerSpeedValue,
  editAgentPickerSpeed,
  editAgentPickerPanelText
} from '../../../../shared/agent-launch-picker-arguments'
import { agentPickerSpeedIsOpaque } from '../../../../shared/agent-launch-picker-speed'
import { editAgentPickerPermission } from '../../../../shared/agent-launch-picker-permission'
import {
  agentPickerButtonOrder,
  agentPickerArgumentsKnown,
  agentPickerDraft,
  agentPickerEffectiveChoices,
  agentPickerModels,
  agentPickerEntryOptions,
  agentPickerPermissions,
  editAgentPickerDraft,
  type AgentPickerEntry,
  type AgentPickerDraft,
  type AgentPickerSurface
} from '../../../../shared/agent-launch-picker'

export function AgentLaunchSetupPanel({
  entry,
  initial,
  disabled,
  onDraftChange,
  onUse
}: {
  entry: AgentPickerEntry
  initial?: AgentPickerDraft
  disabled?: boolean
  onDraftChange?: (draft: AgentPickerDraft) => void
  onUse: (draft: AgentPickerDraft) => void
}) {
  const [draft, updateDraft] = useState(() => initial ?? agentPickerDraft(entry))
  const setDraft = (next: AgentPickerDraft) => {
    updateDraft(next)
    onDraftChange?.(next)
  }
  const [modelQuery, setModelQuery] = useState('')
  const [legacy, setLegacy] = useState(false)
  const [argumentsOpen, setArgumentsOpen] = useState(entry.defaultSurface === 'terminal')
  const argumentsKnown = agentPickerArgumentsKnown(entry, draft)
  const effective = agentPickerEffectiveChoices(entry, draft)
  const models = agentPickerModels(entry)
  const defaultsPending =
    draft.surface === 'chat' ? entry.structuredDefaultsPending : entry.defaultsPending
  const seed = getAgentSessionOptionLaunchCatalog(entry.agent)
  const listedDefaultKnown =
    entry.catalog.origin !== 'unknown' &&
    (entry.catalog.listingNamesConfiguredModel ?? seed?.hostListingNamesConfiguredModel === true)
  const currentModel =
    effective.model ??
    (!defaultsPending && listedDefaultKnown
      ? models.find((model) => model.isDefault)?.id
      : undefined)
  // Settled with nothing chosen still lets the user pick; nothing is checked and the agent keeps its own default.
  const modelDisabled = disabled || defaultsPending
  const options = agentPickerEntryOptions(entry, currentModel, draft.surface)
  const argumentsView = agentPickerPanelArguments(entry, draft, currentModel)
  const optionRows: SessionOptionDescriptor[] = options.map((option) => {
    const liveModel = models.find((model) => model.id === currentModel)
    const current =
      (option.id === 'fastMode' || option.id === 'serviceTier'
        ? agentPickerSpeedValue(entry, draft, option.id)
        : effective.options?.[option.id]) ??
      (currentModel && !defaultsPending
        ? option.kind.type === 'boolean'
          ? String(option.kind.defaultValue)
          : option.id === 'effort'
            ? liveModel?.defaultEffort
            : option.kind.defaultIsCliDefault
              ? option.kind.defaultValue
              : undefined
        : undefined)
    if (agentPickerSpeedIsOpaque(entry, draft, option.id)) {
      return {
        id: option.id,
        label: option.label,
        category: option.category,
        kind: {
          type: 'select',
          choices: [
            {
              value: 'arguments',
              label: translate('agentPicker.setByArguments', 'Set by your Arguments')
            }
          ],
          currentValue: 'arguments'
        },
        valueSource: 'default',
        transport: 'agent-session',
        settable: false
      }
    }
    const valueKnown =
      current !== undefined ||
      (option.id === 'serviceTier' &&
        entry.catalog.origin !== 'unknown' &&
        Boolean(liveModel?.serviceTiers?.length))
    return {
      id: option.id,
      label: option.label,
      category: option.category,
      kind:
        option.kind.type === 'boolean'
          ? { type: 'boolean', currentValue: current === 'true' }
          : {
              type: 'select',
              choices:
                current && !option.kind.choices.some((choice) => choice.value === current)
                  ? [...option.kind.choices, { value: current, label: current }]
                  : option.kind.choices,
              currentValue: current
            },
      valueSource: valueKnown ? 'default' : 'unknown',
      transport: 'agent-session',
      settable:
        !disabled &&
        !defaultsPending &&
        // A settled level the agent picks itself shows unselected but stays pickable.
        (valueKnown || option.kind.type === 'select') &&
        (!(option.id === 'fastMode' || option.id === 'serviceTier') ||
          !entry.surfaces.includes('terminal') ||
          argumentsKnown)
    }
  })
  const renderOptions = (rows: SessionOptionDescriptor[]) => (
    <NativeChatSessionOptionRows
      options={rows}
      shownReason={null}
      pendingIds={new Set()}
      divided={false}
      layout="settings"
      onSet={(option, value) =>
        setDraft(
          option.id === 'fastMode' || option.id === 'serviceTier'
            ? editAgentPickerSpeed(entry, draft, option.id, String(value), currentModel)
            : editAgentPickerDraft(draft, { options: { [option.id]: String(value) } })
        )
      }
      onAction={() => {}}
    />
  )
  const use = (surface: AgentPickerSurface) => onUse({ ...draft, surface })
  const legacyCount = models.filter((model) => model.isLegacy && !model.hidden).length
  return (
    <div
      className="flex w-full flex-col"
      onKeyDown={(event) => {
        event.stopPropagation()
        if (
          !disabled &&
          event.key === 'Enter' &&
          (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        ) {
          event.preventDefault()
          use(entry.defaultSurface)
        }
      }}
    >
      <Command
        surface="inline"
        density="model"
        onKeyDownCapture={(event) => {
          if (
            !disabled &&
            event.key === 'Enter' &&
            event.currentTarget.querySelector(
              '[cmdk-item][data-selected="true"][data-current="true"]'
            )
          ) {
            event.preventDefault()
            event.stopPropagation()
            use(entry.defaultSurface)
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.stopPropagation()
          }
        }}
      >
        <CommandInput
          disabled={modelDisabled}
          value={modelQuery}
          onValueChange={setModelQuery}
          aria-label={translate('agentPicker.searchModels', 'Search models')}
          placeholder={translate('agentPicker.searchAgentModels', 'Search {{agent}} models…', {
            agent: entry.label
          })}
        />
        <CommandList className="max-h-56">
          <CommandEmpty>
            {translate('agentPicker.noModels', 'No models match your search.')}
          </CommandEmpty>
          <CommandGroup>
            {legacy && !modelQuery ? (
              <CommandItem value="__back__" disabled={disabled} onSelect={() => setLegacy(false)}>
                <ChevronLeft className="size-3.5 text-muted-foreground" />
                {translate('agentPicker.legacyModels', 'Legacy models')}
              </CommandItem>
            ) : null}
            {models
              .filter(
                (model) =>
                  !model.hidden &&
                  (model.id === currentModel || modelQuery || Boolean(model.isLegacy) === legacy)
              )
              .map((model) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  keywords={[model.label]}
                  disabled={modelDisabled}
                  data-current={currentModel === model.id}
                  onSelect={() => setDraft(editAgentPickerDraft(draft, { model: model.id }))}
                >
                  {model.label}
                  <span className="ml-auto flex size-3.5 shrink-0 items-center justify-center">
                    {currentModel === model.id ? (
                      <Check className="size-3.5 text-muted-foreground" />
                    ) : null}
                  </span>
                </CommandItem>
              ))}
            {!legacy && !modelQuery && legacyCount > 0 ? (
              <CommandItem value="__legacy__" disabled={disabled} onSelect={() => setLegacy(true)}>
                <span className="flex min-w-0 flex-col">
                  <span>{translate('agentPicker.legacyModels', 'Legacy models')}</span>
                  <span className="text-muted-foreground">
                    {translate('agentPicker.legacyModelCount', '{{total}} models', {
                      total: legacyCount
                    })}
                  </span>
                </span>
                <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />
              </CommandItem>
            ) : null}
            {currentModel && !models.some((model) => model.id === currentModel) ? (
              <CommandItem
                value={currentModel}
                disabled={modelDisabled}
                onSelect={() => {}}
                data-current="true"
              >
                {currentModel}
                <Check className="ml-auto size-3.5 text-muted-foreground" />
              </CommandItem>
            ) : null}
          </CommandGroup>
        </CommandList>
      </Command>
      <div className="grid min-w-0 grid-cols-1 gap-2.5 border-t border-border px-3 pt-2.5 pb-1">
        {renderOptions(
          optionRows.filter((row) => row.id !== 'fastMode' && row.id !== 'serviceTier')
        )}
        <div>
          <AgentPermissionMenu
            agentId={entry.agent}
            label={entry.label}
            layout="row"
            showInherited={false}
            rawValue={argumentsView.selectedPermission ? undefined : argumentsView.permission}
            disabled={
              disabled ||
              defaultsPending ||
              !argumentsView.permission ||
              (entry.surfaces.includes('terminal') && !argumentsKnown)
            }
            permission={{
              choice: argumentsView.selectedPermission ?? 'own',
              defaultChoice: argumentsView.selectedPermission ?? 'own',
              choices: agentPickerPermissions(entry.agent, draft.surface),
              source: 'agent',
              flag: '',
              argsSetPermission: false,
              onSelect: (choice) => {
                if (choice !== 'default') {
                  setDraft(editAgentPickerPermission(entry, draft, choice))
                }
              }
            }}
          />
        </div>
        {renderOptions(
          optionRows.filter((row) => row.id === 'fastMode' || row.id === 'serviceTier')
        )}
        {entry.surfaces.includes('terminal') ? (
          <div>
            <Collapsible open={argumentsOpen} onOpenChange={setArgumentsOpen}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  aria-label={translate('agentPicker.toggleArguments', 'Toggle Arguments')}
                  className="flex min-h-7 w-full items-center gap-1.5 text-left text-xs"
                >
                  <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
                    {argumentsOpen ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {translate('agentPicker.arguments', 'Arguments')}
                  </span>
                  <span className="ml-auto truncate text-muted-foreground/70">
                    {translate(
                      'agentPicker.argumentsTerminalHint',
                      'Only applies to terminal (CLI) launches'
                    )}
                  </span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="pb-1">
                  <AgentDefaultArgsInput
                    hideLabel
                    defaultArgs={argumentsView.text}
                    argsOverride={argumentsView.text}
                    disabled={disabled || !argumentsKnown}
                    onSaveArgs={() => {}}
                    onDraftChange={(text) =>
                      setDraft(editAgentPickerPanelText(entry, draft, text, currentModel))
                    }
                    choiceChips={argumentsView.chips.map((chip) => ({
                      key: chip.key,
                      label: entry.label,
                      source: 'arguments',
                      flag: chip.flag,
                      onRemove: (text) => {
                        setDraft(chip.remove())
                        return text
                      }
                    }))}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-2.5 py-2">
        {agentPickerButtonOrder(entry).map((surface) => (
          <Button
            key={surface}
            type="button"
            size="xs"
            disabled={disabled}
            variant={surface === entry.defaultSurface ? 'default' : 'outline'}
            onClick={() => use(surface)}
          >
            {surface === 'chat'
              ? translate('agentPicker.launchChat', 'Launch chat')
              : translate('agentPicker.launchTerminal', 'Launch terminal')}
            {surface === entry.defaultSurface ? (
              <CornerDownLeft className="size-3 opacity-60" />
            ) : null}
          </Button>
        ))}
      </div>
    </div>
  )
}
