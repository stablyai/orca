import { useRef, useState, type ReactNode, type Ref } from 'react'
import { Check } from 'lucide-react'
import { AgentLaunchTextModelDefault } from './AgentLaunchTextModelDefault'
import { agentLaunchSetupModelRows } from './agent-launch-setup-option-rows'
import { agentLaunchSetupState } from './agent-launch-setup-state'
import { useSetupModelHighlight } from './use-setup-model-highlight'
import { AgentPickerLegacyModelsToggle } from './AgentPickerLegacyModelsToggle'
import { useLegacyModelsExpanded } from './use-legacy-models-expanded'
import { AgentLaunchInstallPrompt } from './AgentLaunchInstallPrompt'
import { retryAgentPickerCatalog } from './agent-launch-picker-acquisition'
import {
  AgentPickerChoiceRows,
  AgentPickerSearchResults,
  choiceMatches,
  setupRowKey,
  type AgentLaunchSetupSearch
} from './agent-picker-search-rows'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem
} from '@/components/ui/command'
import { Button } from '@/components/ui/button'
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
  filterAgentPickerEntries,
  searchAgentPickerModels
} from '../../../../shared/agent-launch/picker/agent-launch-picker-search'
import type {
  AgentPickerDraft,
  AgentPickerEntry,
  AgentPickerSurface
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

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
  /** Select mode: a model pick, which takes the setup instead of only editing it. `close` when Enter picked it. */
  onPickModel?: (draft: AgentPickerDraft, close: boolean) => void
  /** The owning popup takes initial focus through this ref. */
  searchInputRef?: Ref<HTMLInputElement>
  initialQuery?: string
  /** Search every agent's models rather than this agent's. */
  search?: AgentLaunchSetupSearch
  /** Select mode's bottom section, under the effort row. */
  children?: ReactNode
}

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
  // Why: cmdk runs a row's onSelect for both Enter and a click; only Enter also closes.
  const enterPick = useRef(false)
  const takeEnterPick = () => {
    const close = enterPick.current
    enterPick.current = false
    return close
  }
  const editDraft = (edit: AgentPickerEdit) => {
    const current = getDraft()
    if (current) {
      onDraftChange(applyAgentPickerEdit(entry, current, edit), edit.kind)
    }
  }
  const pickModel = (edit: AgentPickerEdit) => {
    const current = getDraft()
    if (current && onPickModel) {
      onPickModel(applyAgentPickerEdit(entry, current, edit), takeEnterPick())
    } else {
      editDraft(edit)
    }
  }
  const [modelQuery, setModelQuery] = useState(initialQuery)
  const state = agentLaunchSetupState(entry, draft, disabled)
  const { models, currentModel, hasModels, catalogPending, catalogMessage, modelInArguments } =
    state
  const { ownerKey } = entry
  const installed = entry.surfaces.length > 0
  const searching = Boolean(search && modelQuery.trim())
  const results = searching && search ? searchAgentPickerModels(search.entries, modelQuery) : []
  // A query naming an agent lists that agent first; picking it keeps the form's own setup.
  const agentResults =
    searching && search
      ? filterAgentPickerEntries(search.entries, modelQuery).filter(
          (candidate) => candidate.surfaces.length > 0
        )
      : []
  const choices = search?.choices ?? []
  const choiceResults = searching
    ? [...(search?.searchChoices ?? []), ...choices].filter((choice) =>
        choiceMatches(choice, modelQuery)
      )
    : []
  const choiceList = useRef<HTMLDivElement>(null)
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
    searching
      ? !agentResults.length && resultStart
        ? setupRowKey(resultStart)
        : undefined
      : modelRows.start,
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
  const focusSearch = () =>
    modelList.current
      ?.querySelector<HTMLInputElement>('[cmdk-input]')
      ?.focus({ preventScroll: true })
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
          const alternate = entry.surfaces.find((surface) => surface !== entry.defaultSurface)
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
          use(entry.defaultSurface)
        }
      }}
    >
      <Command
        surface="inline"
        density="model"
        shouldFilter={!search}
        ref={modelList}
        {...highlight.command}
        onPointerDownCapture={() => {
          enterPick.current = false
        }}
        onKeyDownCapture={(event) => {
          enterPick.current =
            mode === 'select' && event.key === 'Enter' && !isImeOwnedKeyboardEvent(event)
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
            use(entry.defaultSurface)
          }
        }}
        onKeyDown={(event) => {
          // ArrowDown past the last model moves on to the rows under the card.
          if (event.key === 'ArrowDown' && !searching && choices.length) {
            const items = event.currentTarget.querySelectorAll(
              '[cmdk-item]:not([data-disabled="true"])'
            )
            const selected = event.currentTarget.querySelector('[cmdk-item][data-selected="true"]')
            if (!items.length || selected === [...items].at(-1)) {
              event.preventDefault()
              choiceList.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
              return
            }
          }
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
              <div
                className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground"
                role="status"
              >
                <span className="min-w-0 flex-1">{catalogMessage}</span>
                {state.catalogRetryable && ownerKey ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => retryAgentPickerCatalog(ownerKey, entry.agent)}
                  >
                    {t('agentPicker.retryModels', 'Retry')}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {searching && !results.length && !agentResults.length && !choiceResults.length ? (
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
                <AgentPickerSearchResults
                  agents={agentResults}
                  results={results}
                  choices={choiceResults}
                  current={search?.current}
                  disabled={disabled}
                  onPick={(setup) => search?.onPick(setup, takeEnterPick())}
                  onPickAgent={(candidate) => search?.onPickAgent(candidate, takeEnterPick())}
                />
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
        <>
          {installed || searching ? children : null}
          {choices.length && !searching ? (
            <AgentPickerChoiceRows
              ref={choiceList}
              choices={choices}
              disabled={disabled}
              onLeaveUp={focusSearch}
            />
          ) : null}
        </>
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
