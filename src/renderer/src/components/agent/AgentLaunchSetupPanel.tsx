import type { AgentLaunchSetupPanelProps } from './AgentLaunchSetupButton'
import {
  agentLaunchSetupOptionRows,
  agentLaunchSetupCatalogState as catalogState
} from './agent-launch-setup-option-rows'
import { useRef, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session/options/agent-session-option-catalog'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import { agentModelChoiceChips } from '../settings/agent-model-choice-chips'
import { AgentDefaultArgsInput } from '../settings/AgentLaunchDefaultsEditor'
import { NativeChatSessionOptionRows } from '../native-chat/NativeChatSessionOptionRows'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import { AgentPermissionMenu } from '../settings/AgentPermissionChoiceControls'
import {
  AgentLaunchSetupFooter,
  AgentLaunchSurfaceButtons,
  type AgentLaunchSetupFooterHandle
} from './AgentLaunchSetupFooter'
import { agentPickerPanelArguments } from '../../../../shared/agent-launch-picker-arguments'
import {
  acceptAgentPickerArguments,
  applyAgentPickerEdit,
  type AgentPickerEdit
} from '../../../../shared/agent-launch-picker-edits'
import {
  agentPickerArgumentsKnown,
  agentPickerEffectiveChoices,
  agentPickerModels,
  agentPickerEntryOptions,
  agentPickerPermissions,
  type AgentPickerSurface
} from '../../../../shared/agent-launch-picker'

export function AgentLaunchSetupPanel({
  entry,
  draft,
  getDraft,
  mode = 'launch',
  disabled,
  onDraftChange,
  onUse
}: AgentLaunchSetupPanelProps) {
  const footer = useRef<AgentLaunchSetupFooterHandle>(null)
  const editDraft = (edit: AgentPickerEdit) => {
    const current = getDraft()
    if (current) {
      onDraftChange(applyAgentPickerEdit(entry, current, edit))
    }
  }
  const [modelQuery, setModelQuery] = useState('')
  const [legacy, setLegacy] = useState(false)
  const [argumentsOpen, setArgumentsOpen] = useState(entry.defaultSurface === 'terminal')
  const argumentsKnown = agentPickerArgumentsKnown(entry, draft)
  const effective = agentPickerEffectiveChoices(entry, draft)
  const argumentsView = agentPickerPanelArguments(entry, draft)
  const models = agentPickerModels(entry)
  const defaultsPending =
    draft.surface === 'chat' ? entry.structuredDefaultsPending : entry.defaultsPending
  const seed = getAgentSessionOptionLaunchCatalog(entry.agent)
  const listedDefaultKnown =
    entry.catalog.origin !== 'unknown' &&
    (entry.catalog.listingNamesConfiguredModel ?? seed?.hostListingNamesConfiguredModel === true)
  const currentModel =
    argumentsView.choices.model ??
    effective.model ??
    (!draft.delegated?.includes('model') && !defaultsPending && listedDefaultKnown
      ? models.find((model) => model.isDefault)?.id
      : undefined)
  // Settled with nothing chosen still lets the user pick; nothing is checked and the agent keeps its own default.
  const { hasModels, catalogPending, catalogMessage } = catalogState(entry, models, currentModel)
  const modelDisabled = disabled || defaultsPending || catalogPending
  const options = agentPickerEntryOptions(entry, currentModel, draft.surface)
  const optionRows = agentLaunchSetupOptionRows({
    options,
    models,
    entry,
    draft,
    currentModel,
    argumentsView,
    defaultsPending,
    disabled,
    argumentsKnown
  })
  const renderOptions = (rows: SessionOptionDescriptor[]) =>
    rows.length ? (
      <NativeChatSessionOptionRows
        options={rows}
        shownReason={null}
        pendingIds={new Set()}
        divided={false}
        layout="settings"
        onSet={(option, value) =>
          editDraft(
            option.id === 'fastMode' || option.id === 'serviceTier'
              ? {
                  kind: 'speed',
                  key: option.id,
                  value: String(value),
                  model: currentModel
                }
              : {
                  kind: 'choice',
                  patch: { options: { [option.id]: String(value) } }
                }
          )
        }
        onAction={() => {}}
      />
    ) : null
  const handleUse = (surface: AgentPickerSurface) => {
    const current = getDraft()
    if (current) {
      return onUse({ ...acceptAgentPickerArguments(entry, current), surface })
    }
    return false
  }
  const use = (surface: AgentPickerSurface) =>
    mode === 'select' ? handleUse(surface) : footer.current?.launch(surface)
  const choiceChips = agentModelChoiceChips(
    entry.agent,
    entry.label,
    argumentsView.choices,
    (patch) => {
      const key =
        patch.model !== undefined
          ? 'model'
          : patch.permissionMode !== undefined
            ? 'permissionMode'
            : Object.keys(patch.options ?? {})[0]
      editDraft({ kind: 'remove-chip', key })
      return agentPickerPanelArguments(entry, getDraft() ?? draft).text
    },
    argumentsView.context
  )
  const noModelFlag = !seed?.modelApply.cli?.length
  const composed = options.some((option) => option.apply.composedIntoModel)
  const noOptionFlag = options.some(
    (option) => !option.apply.cli?.length && !option.apply.composedIntoModel
  )
  const note =
    noModelFlag || noOptionFlag
      ? translate(
          'agentPicker.chatChoicesNote',
          '{{agent}} model or effort choices without a CLI flag apply to chats.',
          { agent: entry.label }
        )
      : composed
        ? translate(
            'agentPicker.composedChoicesNote',
            '{{agent}} effort and speed choices are included in the model argument.',
            { agent: entry.label }
          )
        : undefined
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
          use(mode === 'select' ? draft.surface : entry.defaultSurface)
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
            use(mode === 'select' ? draft.surface : entry.defaultSurface)
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
          aria-busy={catalogPending}
          value={modelQuery}
          onValueChange={setModelQuery}
          aria-label={translate('agentPicker.searchModels', 'Search models')}
          placeholder={translate('agentPicker.searchAgentModels', 'Search {{agent}} models…', {
            agent: entry.label
          })}
        />
        <CommandList className="max-h-56" data-focus-behavior="page">
          {catalogMessage ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground" role="status">
              {catalogMessage}
            </div>
          ) : null}
          {hasModels &&
          modelQuery &&
          entry.catalog.origin !== 'unknown' &&
          !entry.catalog.listingInProgress &&
          entry.catalogRead !== 'pending' &&
          entry.catalogRead !== 'failed' &&
          entry.catalogRead !== 'unsupported' ? (
            <CommandEmpty>
              {translate('agentPicker.noModels', 'No models match your search.')}
            </CommandEmpty>
          ) : null}
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
                  onSelect={() => editDraft({ kind: 'choice', patch: { model: model.id } })}
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
                  editDraft({ kind: 'permission', value: choice })
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
                    note={note}
                    onSaveArgs={() => editDraft({ kind: 'accept-arguments' })}
                    onDraftChange={(text) =>
                      editDraft({ kind: 'arguments', text, model: currentModel })
                    }
                    choiceChips={choiceChips}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        ) : null}
      </div>
      {mode === 'select' ? (
        <div className="flex items-center justify-end gap-2 border-t border-border px-2.5 py-2">
          <AgentLaunchSurfaceButtons
            entry={entry}
            disabled={disabled}
            primary={draft.surface}
            onSelect={(surface) => {
              void handleUse(surface)
            }}
          />
        </div>
      ) : (
        <AgentLaunchSetupFooter
          ref={footer}
          entry={entry}
          disabled={disabled}
          onLaunch={(surface, prompt) => {
            const current = getDraft()
            return current
              ? onUse({
                  ...acceptAgentPickerArguments(entry, current),
                  surface,
                  ...(prompt ? { prompt } : {})
                })
              : false
          }}
        />
      )}
    </div>
  )
}
