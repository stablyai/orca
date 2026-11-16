import { useRef, useState, type ReactNode, type Ref } from 'react'
import { Check } from 'lucide-react'
import { AgentLaunchTextModelDefault } from './AgentLaunchTextModelDefault'
import { agentLaunchSetupModelRows } from './agent-launch-setup-option-rows'
import { agentLaunchSetupState } from './agent-launch-setup-state'
import { useSetupModelHighlight } from './use-setup-model-highlight'
import { AgentPickerLegacyModelsToggle } from './AgentPickerLegacyModelsToggle'
import { useLegacyModelsExpanded } from './use-legacy-models-expanded'
import { AgentLaunchInstallPrompt } from './AgentLaunchInstallPrompt'
import { AgentVariantIcon } from '@/components/agent/icons/AgentVariantIcon'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem
} from '@/components/ui/command'
import { useTranslate } from '@/i18n/use-translate'
import { isScreenSubmitShortcut } from '@/lib/keyboard/screen-submit-shortcut'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { NativeChatSessionOptionRows } from '../native-chat/session/options/controls/NativeChatSessionOptionRows'
import { AgentLaunchSetupFooter, type AgentLaunchSetupFooterHandle } from './AgentLaunchSetupFooter'
import {
  acceptAgentPickerArguments,
  applyAgentPickerEdit,
  type AgentPickerEdit
} from '../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import { agentPickerCatalogAuthoritative } from '../../../../shared/agent-launch/picker/agent-launch-picker-authority'
import {
  searchAgentPickerModels,
  type AgentPickerSetup
} from '../../../../shared/agent-launch/picker/agent-launch-picker-search'
import type {
  AgentPickerDraft,
  AgentPickerEntry,
  AgentPickerSurface
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

export type AgentLaunchSetupSearch = {
  entries: readonly AgentPickerEntry[]
  /** The agent and model the form holds now, checked among the results. */
  current?: { agent: AgentPickerEntry['agent']; model?: string }
  onPick: (setup: AgentPickerSetup) => void
}

export type AgentLaunchSetupPanelProps = {
  entry: AgentPickerEntry
  draft: AgentPickerDraft
  getDraft: () => AgentPickerDraft | undefined
  mode?: 'launch' | 'select'
  disabled?: boolean
  autoFocus?: boolean
  terminalBlocked?: boolean
  onDraftChange: (draft: AgentPickerDraft, edit: AgentPickerEdit['kind']) => void
  onUse: (draft: AgentPickerDraft) => boolean | void | Promise<boolean>
  /** Select mode: a model pick, which takes the setup instead of only editing it. */
  onPickModel?: (draft: AgentPickerDraft) => void
  /** The owning popup takes initial focus through this ref. */
  searchInputRef?: Ref<HTMLInputElement>
  initialQuery?: string
  /** Search every agent's models rather than this agent's. */
  search?: AgentLaunchSetupSearch
  /** Select mode's bottom section, under the effort row. */
  children?: ReactNode
}

const setupRowKey = (setup: AgentPickerSetup) =>
  `${setup.entry.agent}\u0000${setup.model.id}\u0000${setup.choices.options?.effort ?? ''}`

/** The agent picker's card body: search, the agent's models, then its effort and speed on one row. */
export function AgentLaunchSetupPanel({
  entry,
  draft,
  getDraft,
  mode = 'launch',
  disabled,
  autoFocus = true,
  terminalBlocked,
  onDraftChange,
  onUse,
  onPickModel,
  searchInputRef,
  initialQuery = '',
  search,
  children
}: AgentLaunchSetupPanelProps) {
  const t = useTranslate()
  const footer = useRef<AgentLaunchSetupFooterHandle>(null)
  const editDraft = (edit: AgentPickerEdit) => {
    const current = getDraft()
    if (current) {
      onDraftChange(applyAgentPickerEdit(entry, current, edit), edit.kind)
    }
  }
  const pickModel = (edit: AgentPickerEdit) => {
    const current = getDraft()
    if (current && onPickModel) {
      onPickModel(applyAgentPickerEdit(entry, current, edit))
    } else {
      editDraft(edit)
    }
  }
  const [modelQuery, setModelQuery] = useState(initialQuery)
  const state = agentLaunchSetupState(entry, draft, disabled)
  const { models, currentModel, hasModels, catalogPending, catalogMessage, modelInArguments } =
    state
  const installed = entry.surfaces.length > 0
  const searching = Boolean(search && modelQuery.trim())
  const results = searching && search ? searchAgentPickerModels(search.entries, modelQuery) : []
  const [legacyExpanded, toggleLegacy] = useLegacyModelsExpanded(
    models.some((model) => model.id === currentModel && model.isLegacy)
  )
  const modelRows = agentLaunchSetupModelRows(
    models,
    currentModel,
    modelQuery,
    legacyExpanded,
    modelInArguments
  )
  const modelList = useRef<HTMLDivElement>(null)
  const resultStart = results.find(
    (setup) =>
      setup.entry.agent === search?.current?.agent && setup.model.id === search.current.model
  )
  // A search over every agent starts on the form's current model when it is listed, else on the first result.
  const highlight = useSetupModelHighlight(
    modelList,
    searching ? resultStart && setupRowKey(resultStart) : modelRows.start,
    searching ? '' : modelQuery
  )
  const handleUse = (surface: AgentPickerSurface) => {
    const current = getDraft()
    return current ? onUse({ ...acceptAgentPickerArguments(entry, current), surface }) : false
  }
  const use = (surface: AgentPickerSurface) =>
    mode === 'select' ? handleUse(surface) : footer.current?.launch(surface)
  const renderModelRow = (model: (typeof modelRows.rows)[number]) => {
    const current = model.unlisted || (currentModel === model.id && !modelInArguments)
    return (
      <CommandItem
        key={model.id}
        value={model.id}
        keywords={[model.label]}
        selection="palette"
        disabled={state.modelDisabled}
        data-current={current}
        onSelect={() => {
          if (!model.unlisted) {
            pickModel({ kind: 'choice', patch: { model: model.id } })
          }
        }}
      >
        <span className="min-w-0 flex-1 truncate">{model.label}</span>
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {current ? <Check className="size-3.5 text-muted-foreground" /> : null}
        </span>
      </CommandItem>
    )
  }
  const renderResult = (setup: AgentPickerSetup) => {
    const current =
      setup.entry.agent === search?.current?.agent &&
      setup.model.id === search.current.model &&
      !setup.choices.options?.effort
    const effort = setup.model.efforts.find(
      (choice) => choice.value === setup.choices.options?.effort
    )
    return (
      <CommandItem
        key={setupRowKey(setup)}
        value={setupRowKey(setup)}
        selection="palette"
        disabled={disabled}
        data-current={current}
        onSelect={() => search?.onPick(setup)}
      >
        <AgentVariantIcon agent={setup.entry.agent} size={14} />
        <span className="min-w-0 flex-1 truncate">
          {[setup.model.label, effort?.label].filter(Boolean).join(' · ')}
        </span>
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {current ? <Check className="size-3.5 text-muted-foreground" /> : null}
        </span>
      </CommandItem>
    )
  }
  // Levels lead the row; speed and the rest sit at its end.
  const isLevel = (row: (typeof state.optionRows)[number]) =>
    row.category === 'thought_level' && row.kind.type === 'select'
  const optionRows =
    installed && !searching
      ? [...state.optionRows.filter(isLevel), ...state.optionRows.filter((row) => !isLevel(row))]
      : []
  return (
    <div
      className="flex w-full flex-col"
      data-agent-launch-setup=""
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
        shouldFilter={!search}
        ref={modelList}
        {...highlight.command}
        onKeyDownCapture={(event) => {
          if (
            !disabled &&
            installed &&
            !searching &&
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
          ref={searchInputRef}
          autoFocus={autoFocus}
          disabled={!search && state.modelDisabled}
          aria-busy={catalogPending}
          value={modelQuery}
          onValueChange={setModelQuery}
          aria-label={t('agentPicker.searchModels', 'Search models')}
          placeholder={t('agentPicker.searchAgentModels', 'Search {{agent}} models…', {
            agent: entry.label
          })}
        />
        {!installed && !searching ? (
          <AgentLaunchInstallPrompt entry={entry} />
        ) : (
          <CommandList className="max-h-56 scroll-py-0" data-focus-behavior="page">
            {catalogMessage && !searching ? (
              <div className="px-2.5 py-2 text-xs text-muted-foreground" role="status">
                {catalogMessage}
              </div>
            ) : null}
            {searching && results.length === 0 ? (
              <div className="flex h-9 items-center px-2.5 text-xs text-muted-foreground">
                {t('agentPicker.noModels', 'No models match your search.')}
              </div>
            ) : null}
            {!search && hasModels && modelQuery && agentPickerCatalogAuthoritative(entry) ? (
              <CommandEmpty>
                {t('agentPicker.noModels', 'No models match your search.')}
              </CommandEmpty>
            ) : null}
            <CommandGroup>
              {searching ? (
                results.map(renderResult)
              ) : (
                <>
                  <AgentLaunchTextModelDefault
                    entry={entry}
                    disabled={state.modelDisabled}
                    modelInArguments={modelInArguments}
                    onSelect={pickModel}
                  />
                  {/* One keyed array, so a row moving between sections keeps its highlight. */}
                  {[
                    ...modelRows.rows.map(renderModelRow),
                    ...modelRows.legacyRows.map(renderModelRow),
                    <AgentPickerLegacyModelsToggle
                      key="legacy-toggle"
                      total={modelRows.legacyCount}
                      expanded={legacyExpanded}
                      disabled={disabled}
                      selection="palette"
                      onToggle={toggleLegacy}
                    />
                  ]}
                </>
              )}
            </CommandGroup>
          </CommandList>
        )}
      </Command>
      {optionRows.length ? (
        <div className="flex min-h-9 min-w-0 items-center border-t border-border px-2.5 py-1.5">
          <div className="min-w-0 flex-1">
            <NativeChatSessionOptionRows
              options={optionRows}
              shownReason={null}
              pendingIds={new Set()}
              divided={false}
              layout="inline"
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
          </div>
        </div>
      ) : null}
      {mode === 'select' ? (
        installed || searching ? (
          children
        ) : null
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
