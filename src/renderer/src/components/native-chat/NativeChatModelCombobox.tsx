import { useState } from 'react'
import { Check } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import type { SessionOptionSelectChoice } from '../../../../shared/native-chat-session-options'
import { useNativeChatPickerFocusReturn } from './native-chat-picker-focus-return'
import { nativeChatSessionChoiceLabel } from './native-chat-session-option-labels'
import { NativeChatSessionOptionChoiceBody } from './NativeChatSessionOptionChoiceBody'

type NativeChatModelComboboxProps = {
  choices: readonly SessionOptionSelectChoice[]
  currentValue: string | undefined
  /** Read on mount only: the owner remounts to open on request. */
  defaultOpen: boolean
  /** Choices stay listed and searchable, but cannot be picked. */
  readOnly: boolean
  readOnlyReason: string | null
  onSelect: (value: string) => void
  focusComposer?: () => void
  /** Renders the `PopoverTrigger` pill, which must take the key handler. */
  renderTrigger: (onKeyDown: React.KeyboardEventHandler<HTMLButtonElement>) => React.ReactNode
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
  defaultOpen,
  readOnly,
  readOnlyReason,
  onSelect,
  focusComposer,
  renderTrigger
}: NativeChatModelComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const focusReturn = useNativeChatPickerFocusReturn(focusComposer)
  const searchLabel = translate('components.native-chat.composer.searchModels', 'Search models…')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Why: a popover trigger opens on Enter and Space only; the menu it replaced also took ArrowDown. */}
      {renderTrigger((event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setOpen(true)
        }
      })}
      <PopoverContent
        align="start"
        side="top"
        collisionPadding={8}
        className="w-64"
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        // Why: the popover loops Tab inside itself, which would trap focus in the search field.
        onKeyDown={(event) => {
          if (event.key === 'Tab') {
            setOpen(false)
          }
        }}
      >
        <Command
          density="menu"
          label={searchLabel}
          filter={modelChoiceFilter}
          defaultValue={currentValue}
        >
          <CommandInput placeholder={searchLabel} />
          {readOnly && readOnlyReason ? (
            <div className="px-3 py-1.5 text-xs text-muted-foreground">{readOnlyReason}</div>
          ) : null}
          <CommandList animateHeight>
            <CommandEmpty>
              {translate(
                'components.native-chat.composer.noModelsMatch',
                'No models match your search.'
              )}
            </CommandEmpty>
            {choices.map((choice) => {
              const label = nativeChatSessionChoiceLabel(choice)
              const current = choice.value === currentValue
              return (
                <CommandItem
                  key={choice.value}
                  value={choice.value}
                  keywords={[label, choice.description ?? '']}
                  disabled={readOnly}
                  aria-current={current || undefined}
                  onSelect={() => {
                    focusReturn.notePick()
                    setOpen(false)
                    onSelect(choice.value)
                  }}
                >
                  <span className="flex size-3.5 shrink-0 items-center justify-center">
                    {current ? <Check className="size-3.5" /> : null}
                  </span>
                  <NativeChatSessionOptionChoiceBody
                    label={label}
                    description={choice.description}
                  />
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
