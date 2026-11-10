import { AgentLaunchTextModelDefault } from './AgentLaunchTextModelDefault'
import { textActionArgumentsOwnModel } from '../../../../shared/agent-launch/picker/agent-launch-picker-text-action'
import type { AgentLaunchSetupPanelProps } from './AgentLaunchSetupButton'
import {
  agentLaunchSetupOptionRows,
  agentLaunchSetupRowGroups,
  agentLaunchSetupCatalogState as catalogOf,
  agentLaunchSetupModelRows
} from './agent-launch-setup-option-rows'
import { useRef, useState } from 'react'
import { useSetupModelHighlight } from './use-setup-model-highlight'
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
import { useTranslate } from '@/i18n/use-translate'
import { agentModelChoiceChips } from './launch-settings/agent-model-choice-chips'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { AgentDefaultArgsInput } from './launch-settings/AgentLaunchDefaultsEditor'
import { NativeChatSessionOptionRows } from '../native-chat/session/options/controls/NativeChatSessionOptionRows'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import { AgentPermissionMenu } from './launch-settings/AgentPermissionMenu'
import {
  AgentLaunchSetupFooter,
  agentLaunchSetupArgumentsNote,
  type AgentLaunchSetupFooterHandle
} from './AgentLaunchSetupFooter'
import { AgentLaunchSetupActions } from './AgentLaunchSetupActions'
import { agentPickerPanelArguments } from '../../../../shared/agent-launch/picker/agent-launch-picker-arguments'
import {
  acceptAgentPickerArguments,
  applyAgentPickerEdit,
  type AgentPickerEdit
} from '../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import {
  agentPickerArgumentsKnown,
  agentPickerCatalogAuthoritative
} from '../../../../shared/agent-launch/picker/agent-launch-picker-authority'
import { agentPickerEffectiveChoices } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { AgentPickerSurface } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import {
  agentPickerModels,
  agentPickerEntryOptions,
  agentPickerPermissions
} from '../../../../shared/agent-launch/picker/agent-launch-picker-catalog'

export function AgentLaunchSetupPanel({
  entry,
  draft,
  getDraft,
  mode = 'launch',
  disabled,
  autoFocus = true,
  terminalBlocked,
  onDraftChange,
  onUse
}: AgentLaunchSetupPanelProps) {
  const t = useTranslate()
  const footer = useRef<AgentLaunchSetupFooterHandle>(null)
  const editDraft = (edit: AgentPickerEdit) => {
    const current = getDraft()
    if (current) {
      onDraftChange(applyAgentPickerEdit(entry, current, edit), edit.kind)
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
  const { hasModels, catalogPending, catalogMessage } = catalogOf(entry, models, currentModel, mode)
  const modelInArguments = textActionArgumentsOwnModel(entry, draft)
  const modelDisabled = disabled || defaultsPending || catalogPending
  const modelRows = agentLaunchSetupModelRows(
    models,
    currentModel,
    modelQuery,
    legacy,
    modelInArguments
  )
  const modelList = useRef<HTMLDivElement>(null)
  const highlight = useSetupModelHighlight(modelList, modelRows.start, modelQuery)
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
  const renderOptions = (rows: SessionOptionDescriptor[], layout?: 'inline') =>
    rows.length ? (
      <NativeChatSessionOptionRows
        options={rows}
        shownReason={null}
        pendingIds={new Set()}
        divided={false}
        layout={layout ?? 'settings'}
        onSet={(option, value) => {
          if (entry.textGeneration && value === 'arguments') {
            return
          }
          editDraft(
            option.id === 'fastMode' || option.id === 'serviceTier'
              ? { kind: 'speed', key: option.id, value: String(value), model: currentModel }
              : { kind: 'choice', patch: { options: { [option.id]: String(value) } } }
          )
        }}
        onAction={() => {}}
      />
    ) : null
  const handleUse = (surface: AgentPickerSurface) => {
    const current = getDraft()
    return current ? onUse({ ...acceptAgentPickerArguments(entry, current), surface }) : false
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
  const rowGroups = agentLaunchSetupRowGroups(optionRows, mode === 'launch')
  // Launch leaves Permissions and Arguments to Agent settings; select mode edits a saved setup.
  const editsDefaults = mode === 'select' && !entry.textGeneration
  const note = agentLaunchSetupArgumentsNote(entry.label, options, !seed?.modelApply.cli?.length)
  const legacyCount = models.filter((model) => model.isLegacy && !model.hidden).length
  return (
    <div
      className="flex w-full flex-col"
      onKeyDownCapture={(event) => {
        if (isScreenSubmitShortcut(event)) {
          event.preventDefault()
          event.stopPropagation()
          const primary = mode === 'select' ? draft.surface : entry.defaultSurface
          const alternate = entry.surfaces.find((surface) => surface !== primary)
          if (alternate && !disabled && !event.repeat) {
            use(alternate)
          }
        }
      }}
      onKeyDown={(event) => {
        highlight.endKey()
        event.stopPropagation()
        if (
          !disabled &&
          !isImeOwnedKeyboardEvent(event) &&
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
        ref={modelList}
        {...highlight.command}
        onKeyDownCapture={(event) => {
          if (
            !disabled &&
            !isImeOwnedKeyboardEvent(event) &&
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
          highlight.onKeyDown(event)
          if (event.key === 'Enter') {
            event.stopPropagation()
          }
        }}
      >
        <CommandInput
          autoFocus={autoFocus}
          disabled={modelDisabled}
          aria-busy={catalogPending}
          value={modelQuery}
          onValueChange={setModelQuery}
          aria-label={t('agentPicker.searchModels', 'Search models')}
          placeholder={t('agentPicker.searchAgentModels', 'Search {{agent}} models…', {
            agent: entry.label
          })}
        />
        <CommandList className="max-h-56" data-focus-behavior="page">
          {catalogMessage ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground" role="status">
              {catalogMessage}
            </div>
          ) : null}
          {hasModels && modelQuery && agentPickerCatalogAuthoritative(entry) ? (
            <CommandEmpty>{t('agentPicker.noModels', 'No models match your search.')}</CommandEmpty>
          ) : null}
          <CommandGroup>
            <AgentLaunchTextModelDefault
              entry={entry}
              disabled={modelDisabled}
              modelInArguments={modelInArguments}
              onSelect={editDraft}
            />
            {legacy && !modelQuery ? (
              <CommandItem value="__back__" disabled={disabled} onSelect={() => setLegacy(false)}>
                <ChevronLeft className="size-3.5 text-muted-foreground" />
                {t('agentPicker.legacyModels', 'Legacy models')}
              </CommandItem>
            ) : null}
            {modelRows.rows.map((model) => {
              const current = model.unlisted || (currentModel === model.id && !modelInArguments)
              return (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  keywords={[model.label]}
                  disabled={modelDisabled}
                  data-current={current}
                  onSelect={() => {
                    if (!model.unlisted) {
                      editDraft({ kind: 'choice', patch: { model: model.id } })
                    }
                  }}
                >
                  {model.label}
                  <span className="ml-auto flex size-3.5 shrink-0 items-center justify-center">
                    {current ? <Check className="size-3.5 text-muted-foreground" /> : null}
                  </span>
                </CommandItem>
              )
            })}
            {!legacy && !modelQuery && legacyCount > 0 ? (
              <CommandItem value="__legacy__" disabled={disabled} onSelect={() => setLegacy(true)}>
                <span className="flex min-w-0 flex-col">
                  <span>{t('agentPicker.legacyModels', 'Legacy models')}</span>
                  <span className="text-muted-foreground">
                    {t('agentPicker.legacyModelCount', '{{total}} models', {
                      total: legacyCount
                    })}
                  </span>
                </span>
                <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />
              </CommandItem>
            ) : null}
          </CommandGroup>
        </CommandList>
      </Command>
      <div className="grid min-w-0 grid-cols-1 gap-2.5 border-t border-border px-3 pt-2.5 pb-1">
        {mode === 'launch' && renderOptions([...rowGroups.level, ...rowGroups.speed], 'inline')}
        {renderOptions(rowGroups.rest)}
        {editsDefaults ? (
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
        ) : null}
        {mode === 'select' ? renderOptions(rowGroups.speed) : null}
        {editsDefaults && entry.surfaces.includes('terminal') ? (
          <div>
            <Collapsible open={argumentsOpen} onOpenChange={setArgumentsOpen}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  aria-label={t('agentPicker.toggleArguments', 'Toggle Arguments')}
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
                    {t('agentPicker.arguments', 'Arguments')}
                  </span>
                  <span className="ml-auto truncate text-muted-foreground/70">
                    {t(
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
        <AgentLaunchSetupActions
          entry={entry}
          disabled={disabled}
          surface={draft.surface}
          onUse={(surface) => {
            void handleUse(surface)
          }}
        />
      ) : (
        <AgentLaunchSetupFooter
          ref={footer}
          entry={entry}
          terminalBlocked={terminalBlocked}
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
