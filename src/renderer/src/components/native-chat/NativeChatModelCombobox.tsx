import { useRef } from 'react'
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
import { translate } from '@/i18n/i18n'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice
} from '../../../../shared/native-chat/input/native-chat-session-options'
import { nativeChatSessionChoiceLabel } from '../../../../shared/native-chat-session-option-labels'
import { sayNativeChatSessionOptionTranslated as say } from './native-chat-session-option-labels-text'
import { NativeChatSessionOptionChoiceBody } from './NativeChatSessionOptionChoiceBody'
import { NativeChatSessionOptionWriteGroup } from './NativeChatSessionOptionWriteGroup'

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
  defaultChoice?: SessionOptionDescriptor['defaultChoice']
  onReset?: () => void
}

// Why not cmdk's scorer: it matches scattered letters and reorders the host's list.
function modelChoiceFilter(value: string, search: string, keywords?: string[]): number {
  const haystack = [value, ...(keywords ?? [])].join(' ').toLowerCase()
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
  return terms.every((term) => haystack.includes(term)) ? 1 : 0
}

export function NativeChatModelCombobox({
  choices,
  currentValue,
  readOnly,
  readOnlyReason,
  busy,
  onSelect,
  defaultChoice,
  onReset
}: NativeChatModelComboboxProps): React.JSX.Element {
  const searchLabel = translate('components.native-chat.composer.searchModels', 'Search models…')
  const search = useRef<HTMLInputElement>(null)
  return (
    <Command
      surface="inline"
      density="menu"
      label={searchLabel}
      filter={modelChoiceFilter}
      defaultValue={currentValue}
    >
      <CommandInput ref={search} placeholder={searchLabel} />
      {readOnly && readOnlyReason ? (
        <div className="px-3 py-1.5 text-xs text-muted-foreground">{readOnlyReason}</div>
      ) : null}
      <CommandList
        animateHeight
        // cmdk rows override inherited aria-disabled, so announce pending writes on the list too.
        aria-busy={busy}
        // Keep focus in search; model changes can remove or disable the clicked option.
        onMouseDown={(event) => {
          event.preventDefault()
          search.current?.focus()
        }}
      >
        <CommandEmpty>
          {translate(
            'components.native-chat.composer.noModelsMatch',
            'No models match your search.'
          )}
        </CommandEmpty>
        <NativeChatSessionOptionWriteGroup busy={busy}>
          <CommandGroup>
            {defaultChoice && onReset ? (
              <CommandItem
                value="provider-default-action"
                keywords={[
                  translate('components.native-chat.composer.defaultModel', 'Default'),
                  defaultChoice.model?.label ?? '',
                  defaultChoice.model?.description ?? ''
                ]}
                selection="palette"
                disabled={readOnly}
                aria-current={defaultChoice.selected || undefined}
                onSelect={() => {
                  if (!defaultChoice.selected) {
                    onReset()
                  }
                }}
              >
                <NativeChatSessionOptionChoiceBody
                  label={translate('components.native-chat.composer.defaultModel', 'Default')}
                  description={
                    defaultChoice.model?.label ??
                    translate(
                      'components.native-chat.composer.defaultModelNotReported',
                      'Default model not reported'
                    )
                  }
                  detail={defaultChoice.model?.description}
                />
                <span className="ml-auto flex size-3.5 shrink-0 items-center justify-center">
                  {defaultChoice.selected ? (
                    <Check className="size-3.5 text-muted-foreground" />
                  ) : null}
                </span>
              </CommandItem>
            ) : null}
            {choices.map((choice) => {
              const label = nativeChatSessionChoiceLabel(choice, say)
              const current = !defaultChoice?.selected && choice.value === currentValue
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
                    description={nativeChatModelDescription(choice.value, choice.description)}
                  />
                  {/* Reserve the check slot so selecting a model cannot rewrap its label. */}
                  <span className="ml-auto flex size-3.5 shrink-0 items-center justify-center">
                    {current ? <Check className="size-3.5 text-muted-foreground" /> : null}
                  </span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        </NativeChatSessionOptionWriteGroup>
      </CommandList>
    </Command>
  )
}
