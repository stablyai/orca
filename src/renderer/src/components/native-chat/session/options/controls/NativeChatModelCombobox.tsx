import { useId, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { nativeChatModelDescription } from './native-chat-model-description'
import { useTranslate } from '@/i18n/use-translate'
import type {
  SessionOptionsCliUpdate,
  SessionOptionSelectChoice
} from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { nativeChatSessionChoiceLabel } from '../../../../../../../shared/native-chat/input/session-options/native-chat-session-option-labels'
import { sayNativeChatSessionOptionTranslated as say } from './native-chat-session-option-labels-text'
import { NativeChatSessionOptionChoiceBody } from './NativeChatSessionOptionChoiceBody'
import { NativeChatSessionOptionWriteGroup } from './NativeChatSessionOptionWriteGroup'
import { AgentPickerLegacyModelsToggle } from '../../../../agent/AgentPickerLegacyModelsToggle'
import { useLegacyModelsExpanded } from '../../../../agent/use-legacy-models-expanded'
import { NativeChatModelNeedsCliUpdateRow } from './NativeChatModelNeedsCliUpdateRow'
import { NativeChatModelDetailsCard } from './NativeChatModelDetailsCard'

const LIST_NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End'])

type NativeChatModelComboboxProps = {
  choices: readonly SessionOptionSelectChoice[]
  currentValue: string | undefined
  /** Choices stay listed and searchable, but cannot be picked. */
  readOnly: boolean
  readOnlyReason: string | null
  /** A write is in flight; the rows take no pick until it settles, and the search stays usable. */
  busy: boolean
  /** Called for a model other than the current one; the list stays as it is. */
  onSelect: (value: string) => void
  /** The chat host's own CLI, too old for models on Orca's list. */
  cliUpdate?: SessionOptionsCliUpdate
}

// Why not cmdk's scorer: it matches scattered letters and reorders the host's list.
function modelChoiceFilter(value: string, search: string, keywords?: string[]): number {
  const haystack = [value, ...(keywords ?? [])].join(' ').toLowerCase()
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
  return terms.every((term) => haystack.includes(term)) ? 1 : 0
}

/** Searchable model picker with hover and keyboard-accessible model details. */
export function NativeChatModelCombobox({
  choices,
  currentValue,
  readOnly,
  readOnlyReason,
  busy,
  onSelect,
  cliUpdate
}: NativeChatModelComboboxProps): React.JSX.Element {
  const t = useTranslate()
  const searchLabel = t('components.native-chat.composer.searchModels', 'Search models…')
  const search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [legacyExpanded, toggleLegacy] = useLegacyModelsExpanded(
    choices.some((choice) => choice.value === currentValue && choice.legacy)
  )
  const searching = Boolean(query.trim())
  // Membership ignores the selection, so picking a model never moves rows in the open list.
  const folded = (choice: SessionOptionSelectChoice) => !searching && Boolean(choice.legacy)
  // The current value stays listed even while a pending pick still carries its hidden flag.
  const listed = choices.filter(
    (choice) => searching || !choice.hidden || choice.value === currentValue
  )
  const legacyChoices = listed.filter(folded)
  // A model the CLI already lists is pickable, whatever the list says it needs.
  const needsUpdate = cliUpdate
    ? cliUpdate.models.filter((model) => !choices.some((choice) => choice.value === model.id))
    : []
  // Controlled because cmdk reports highlight moves only to a controlled root.
  const [highlighted, setHighlighted] = useState(currentValue ?? '')
  // The row whose details card is open: the hovered row, or the row arrow keys moved to.
  const [detailsValue, setDetailsValue] = useState<string | null>(null)
  const detailsIdPrefix = useId()
  const navigatingByKey = useRef(false)
  const renderChoice = (choice: SessionOptionSelectChoice) => {
    const label = nativeChatSessionChoiceLabel(choice, say)
    const current = choice.value === currentValue
    const detailsOpen = choice.details !== undefined && detailsValue === choice.value
    const detailsId = `${detailsIdPrefix}-${choice.value.replace(/\s+/g, '-')}`
    const item = (
      <CommandItem
        key={choice.value}
        value={choice.value}
        keywords={[label, choice.description ?? '']}
        selection="palette"
        disabled={readOnly}
        aria-current={current || undefined}
        aria-describedby={detailsOpen ? detailsId : undefined}
        onSelect={() => {
          if (!current) {
            onSelect(choice.value)
          }
        }}
      >
        <NativeChatSessionOptionChoiceBody
          label={label}
          description={nativeChatModelDescription(choice.value, choice.description, t)}
        />
        {/* Reserve the check slot so selecting a model cannot rewrap its label. */}
        <span className="ml-auto flex size-3.5 shrink-0 items-center justify-center">
          {current ? <Check className="size-3.5 text-muted-foreground" /> : null}
        </span>
      </CommandItem>
    )
    if (!choice.details) {
      return item
    }
    const details = choice.details
    return (
      <HoverCard
        key={choice.value}
        open={detailsOpen}
        onOpenChange={(open) => {
          navigatingByKey.current = false
          setDetailsValue((shown) => (open ? choice.value : shown === choice.value ? null : shown))
        }}
        openDelay={300}
        closeDelay={100}
      >
        <HoverCardTrigger asChild>{item}</HoverCardTrigger>
        <HoverCardContent
          id={detailsId}
          side="left"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          variant="row-details"
        >
          <NativeChatModelDetailsCard label={label} details={details} />
        </HoverCardContent>
      </HoverCard>
    )
  }
  return (
    <Command
      surface="inline"
      density="menu"
      label={searchLabel}
      filter={modelChoiceFilter}
      value={highlighted}
      onValueChange={(value) => {
        setHighlighted(value)
        if (navigatingByKey.current) {
          setDetailsValue(value)
        }
      }}
    >
      <CommandInput
        ref={search}
        placeholder={searchLabel}
        value={query}
        onValueChange={(value) => {
          setQuery(value)
          navigatingByKey.current = false
          setDetailsValue(null)
        }}
        // Runs before cmdk's root handler moves the highlight, so the move opens that row's card.
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
            navigatingByKey.current = false
            return
          }
          navigatingByKey.current = LIST_NAVIGATION_KEYS.has(event.key)
          if (navigatingByKey.current) {
            // A no-op move (one visible row, or a list edge) fires no onValueChange; open that row now.
            setDetailsValue(highlighted)
          } else {
            setDetailsValue(null)
          }
        }}
      />
      {readOnly && readOnlyReason ? (
        <div className="px-3 py-1.5 text-xs text-muted-foreground">{readOnlyReason}</div>
      ) : null}
      <CommandList
        animateHeight
        className="max-h-[min(233px,60vh)] h-[min(var(--cmdk-list-height),233px,60vh)]"
        // cmdk rows override inherited aria-disabled, so announce pending writes on the list too.
        aria-busy={busy}
        // Keep focus in search; model changes can remove or disable the clicked option.
        onMouseDown={(event) => {
          event.preventDefault()
          search.current?.focus()
        }}
      >
        <CommandEmpty>
          {t('components.native-chat.composer.noModelsMatch', 'No models match your search.')}
        </CommandEmpty>
        <NativeChatSessionOptionWriteGroup busy={busy}>
          <CommandGroup>
            {/* One keyed array, so a row moving between sections keeps its highlight. */}
            {[
              ...(cliUpdate
                ? needsUpdate.map((model) => (
                    <NativeChatModelNeedsCliUpdateRow
                      key={`cli-update:${model.id}`}
                      model={model}
                      update={cliUpdate}
                    />
                  ))
                : []),
              ...listed.filter((choice) => !folded(choice)).map(renderChoice),
              ...(legacyExpanded ? legacyChoices.map(renderChoice) : []),
              <AgentPickerLegacyModelsToggle
                key="legacy-toggle"
                total={legacyChoices.length}
                expanded={legacyExpanded}
                selection="palette"
                onToggle={toggleLegacy}
              />
            ]}
          </CommandGroup>
        </NativeChatSessionOptionWriteGroup>
      </CommandList>
    </Command>
  )
}
