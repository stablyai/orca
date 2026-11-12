import { useRef, useState } from 'react'
import { Check } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { nativeChatModelDescription } from './native-chat-model-description'
import { useTranslate } from '@/i18n/use-translate'
import type { SessionOptionSelectChoice } from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { nativeChatSessionChoiceLabel } from '../../../../../../../shared/native-chat/input/native-chat-session-option-labels'
import { sayNativeChatSessionOptionTranslated as say } from './native-chat-session-option-labels-text'
import { NativeChatSessionOptionChoiceBody } from './NativeChatSessionOptionChoiceBody'
import { NativeChatSessionOptionWriteGroup } from './NativeChatSessionOptionWriteGroup'
import { nativeChatModelSearchScore } from '../../../../../../../shared/native-chat/input/native-chat-model-search'
import { AgentPickerLegacyModelsToggle } from '../../../../agent/AgentPickerLegacyModelsToggle'
import { useLegacyModelsExpanded } from '../../../../agent/use-legacy-models-expanded'

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
}

export function NativeChatModelCombobox({
  choices,
  currentValue,
  readOnly,
  readOnlyReason,
  busy,
  onSelect
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
  const legacyChoices = choices.filter(folded)
  const renderChoice = (choice: SessionOptionSelectChoice) => {
    const label = nativeChatSessionChoiceLabel(choice, say)
    const current = choice.value === currentValue
    return (
      <CommandItem
        key={choice.value}
        value={choice.value}
        keywords={[label, choice.description ?? '']}
        selection="palette"
        disabled={readOnly}
        aria-current={current || undefined}
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
  }
  return (
    <Command
      surface="inline"
      density="menu"
      label={searchLabel}
      filter={nativeChatModelSearchScore}
      defaultValue={currentValue}
    >
      <CommandInput ref={search} placeholder={searchLabel} value={query} onValueChange={setQuery} />
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
              ...choices.filter((choice) => !folded(choice)).map(renderChoice),
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
