import { useId, useMemo, useRef, useState } from 'react'
import { Command, CommandInput, CommandList, CommandOption } from '@/components/ui/command'
import {
  getWindowedCommandNavigation,
  useCommandInputActiveDescendant
} from '@/lib/list-interaction/windowed-command-navigation'
import { useWindowedCommandVirtualizer } from '@/lib/list-interaction/use-windowed-command-virtualizer'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import type { SessionOptionSelectChoice } from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { NativeChatSessionOptionChoiceBody } from './NativeChatSessionOptionChoiceBody'

export function NativeChatReviewChoices(props: {
  choices: readonly SessionOptionSelectChoice[]
  label: string
  busy: boolean
  onSelect: (value: string) => void
  onSubmit?: (instructions: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const prefix = useId()
  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    return props.choices.filter((choice) =>
      terms.every((term) =>
        `${choice.label} ${choice.description ?? ''} ${choice.value}`.toLowerCase().includes(term)
      )
    )
  }, [props.choices, query])
  const ids = useMemo(() => filtered.map((choice) => choice.value), [filtered])
  const indexes = useMemo(() => new Map(ids.map((id, index) => [id, index])), [ids])
  const active = highlighted !== null && indexes.has(highlighted) ? highlighted : (ids[0] ?? null)
  const activeIndex = active === null ? -1 : (indexes.get(active) ?? -1)
  const virtualizer = useWindowedCommandVirtualizer({
    itemKeys: ids,
    scrollElement: () => list.current,
    estimateSize: () => 56,
    activeIndex,
    overscan: 4,
    initialRect: { width: 384, height: 233 }
  })
  useCommandInputActiveDescendant(input, activeIndex < 0 ? null : `${prefix}-${activeIndex}`)
  return (
    <Command surface="inline" density="menu" label={props.label} shouldFilter={false}>
      <CommandInput
        ref={input}
        placeholder={props.label}
        value={query}
        onValueChange={(value) => {
          setQuery(value)
          setHighlighted(null)
          virtualizer.scrollToOffset(0)
        }}
        onKeyDown={(event) => {
          const navigation = getWindowedCommandNavigation(event, ids, active)
          if (navigation) {
            event.preventDefault()
            if (navigation.targetId !== null) {
              setHighlighted(navigation.targetId)
              virtualizer.scrollToIndex(indexes.get(navigation.targetId) ?? 0)
            }
          } else if (event.key === 'Enter' && !isImeOwnedKeyboardEvent(event)) {
            event.preventDefault()
            if (!props.busy) {
              if (props.onSubmit) {
                props.onSubmit(query)
              } else if (active !== null) {
                props.onSelect(active)
              }
            }
          }
        }}
      />
      <CommandList
        ref={list}
        aria-busy={props.busy}
        className="max-h-[min(233px,60vh)]"
        onMouseDown={(event) => {
          event.preventDefault()
          input.current?.focus()
        }}
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const choice = filtered[row.index]!
            return (
              <CommandOption
                key={choice.value}
                ref={virtualizer.measureElement}
                data-index={row.index}
                id={`${prefix}-${row.index}`}
                value={choice.value}
                selection="palette"
                selected={choice.value === active}
                disabled={props.busy}
                aria-posinset={row.index + 1}
                aria-setsize={filtered.length}
                onHighlight={() => setHighlighted(choice.value)}
                onSelect={() => props.onSelect(choice.value)}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <NativeChatSessionOptionChoiceBody
                  label={choice.label}
                  description={choice.description}
                />
              </CommandOption>
            )
          })}
        </div>
      </CommandList>
    </Command>
  )
}
