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
import { translate } from '@/i18n/i18n'
import type { SessionOptionSelectChoice } from '../../../../shared/native-chat/input/native-chat-session-options'
import { nativeChatSessionChoiceLabel } from '../../../../shared/native-chat/input/native-chat-session-option-labels'
import { sayNativeChatSessionOptionTranslated as say } from './native-chat-session-option-labels-text'
import { NativeChatSessionOptionChoiceBody } from './NativeChatSessionOptionChoiceBody'
import { NativeChatSessionOptionWriteGroup } from './NativeChatSessionOptionWriteGroup'
import { NativeChatModelDetailsCard } from './NativeChatModelDetailsCard'

const LIST_NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

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
  onSelect
}: NativeChatModelComboboxProps): React.JSX.Element {
  const searchLabel = translate('components.native-chat.composer.searchModels', 'Search models…')
  const search = useRef<HTMLInputElement>(null)
  const detailsIdPrefix = useId()
  // The row whose details card is open: the hovered row, or the row arrow keys moved to.
  const [detailsValue, setDetailsValue] = useState<string | null>(null)
  const navigatingByKey = useRef(false)
  // Controlled because cmdk reports highlight moves only to a controlled root.
  const [highlighted, setHighlighted] = useState(currentValue ?? '')
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
        // Runs before cmdk's root handler moves the highlight, so the move opens that row's card.
        onKeyDown={(event) => {
          navigatingByKey.current = LIST_NAVIGATION_KEYS.has(event.key)
          if (!navigatingByKey.current) {
            setDetailsValue(null)
          }
        }}
      />
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
            {choices.map((choice, index) => {
              const label = nativeChatSessionChoiceLabel(choice, say)
              const current = choice.value === currentValue
              const detailsOpen = choice.details !== undefined && detailsValue === choice.value
              const detailsId = `${detailsIdPrefix}-${index}`
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
                    description={nativeChatModelDescription(choice.value, choice.description)}
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
                    setDetailsValue((shown) =>
                      open ? choice.value : shown === choice.value ? null : shown
                    )
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
                    // Above the z-[60] popover that hosts the picker.
                    className="z-[90]"
                  >
                    <NativeChatModelDetailsCard label={label} details={details} />
                  </HoverCardContent>
                </HoverCard>
              )
            })}
          </CommandGroup>
        </NativeChatSessionOptionWriteGroup>
      </CommandList>
    </Command>
  )
}
