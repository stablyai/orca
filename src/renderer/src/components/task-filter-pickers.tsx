// Why: provider-neutral single/multi select pickers shared by the GitHub PR
// toolbar and the Linear issue toolbar, kept outside github/ so generic task
// filtering never depends on a provider-specific module.
import React, { useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'

export type PickerOption = { key: string; primary: string; secondary?: string }

export const TASK_PICKER_QUERY_MAX_BYTES = 2 * 1024

export function isTaskPickerQueryTooLarge(
  query: string,
  maxBytes = TASK_PICKER_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function getTaskPickerQueryState(query: string): {
  queryTooLarge: boolean
  trimmedQuery: string
} {
  const queryTooLarge = isTaskPickerQueryTooLarge(query)
  return {
    queryTooLarge,
    trimmedQuery: queryTooLarge ? '' : query.trim()
  }
}

// Why: generic over the option type so callers can carry render metadata
// (color, avatar) on their options instead of re-joining by key in render.
export function filterTaskPickerOptions<O extends PickerOption>(options: O[], query: string): O[] {
  const { queryTooLarge, trimmedQuery } = getTaskPickerQueryState(query)
  if (queryTooLarge) {
    return []
  }
  if (!trimmedQuery) {
    return options
  }
  const q = trimmedQuery.toLowerCase()
  return options.filter(
    (o) => o.primary.toLowerCase().includes(q) || (o.secondary ?? '').toLowerCase().includes(q)
  )
}

export function SingleSelectList<O extends PickerOption>({
  options,
  activeValue,
  loading,
  error,
  searchPlaceholder,
  emptyText,
  renderOption,
  allowCustomValue,
  onSelect
}: {
  options: O[]
  activeValue: string | null
  loading: boolean
  error: string | null
  searchPlaceholder: string
  emptyText?: string
  renderOption?: (opt: O) => React.ReactNode
  // Why: PR authors and reviewers can be external contributors who aren't in
  // `listAssignableUsers` (repo collaborators only). Allowing a typed login as
  // a fallback lets the user filter by anyone GitHub recognizes.
  allowCustomValue?: boolean
  onSelect: (value: string | null) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => filterTaskPickerOptions(options, query), [options, query])
  const { queryTooLarge, trimmedQuery } = getTaskPickerQueryState(query)
  const showCustom =
    allowCustomValue &&
    trimmedQuery.length > 0 &&
    !queryTooLarge &&
    !filtered.some((o) => o.key.toLowerCase() === trimmedQuery.toLowerCase())
  const fallback = loading
    ? translate('auto.components.task.filter.pickers.96cc85e839', 'Loading…')
    : queryTooLarge
      ? translate('auto.components.task.filter.pickers.2c3b81720a', 'Search text is too large.')
      : showCustom
        ? translate(
            'auto.components.task.filter.pickers.96b30a41bc',
            'Press Enter to use the typed value.'
          )
        : (error ??
          emptyText ??
          translate('auto.components.task.filter.pickers.8776bc66db', 'No matches'))

  return (
    <Command shouldFilter={false}>
      <CommandInput
        placeholder={searchPlaceholder}
        value={query}
        onValueChange={setQuery}
        className="text-xs"
      />
      <CommandList>
        <CommandEmpty>{fallback}</CommandEmpty>
        {showCustom ? (
          <CommandItem
            value={`__custom__:${trimmedQuery}`}
            onSelect={() => onSelect(trimmedQuery)}
            className="items-center gap-2 px-3 py-1.5 text-xs"
          >
            <span className="text-muted-foreground">
              {translate('auto.components.task.filter.pickers.783279c991', 'Use')}
            </span>
            <span className="truncate font-medium">{trimmedQuery}</span>
          </CommandItem>
        ) : null}
        {activeValue ? (
          <CommandItem
            value="__clear__"
            onSelect={() => onSelect(null)}
            className="gap-2 px-3 py-1.5 text-xs text-muted-foreground"
          >
            {translate('auto.components.task.filter.pickers.d58aef2697', 'Clear')}
          </CommandItem>
        ) : null}
        {filtered.map((opt) => {
          const isActive = opt.key === activeValue
          return (
            <CommandItem
              key={opt.key}
              value={opt.key}
              onSelect={() => onSelect(isActive ? null : opt.key)}
              className="items-center gap-2 px-3 py-1.5 text-xs"
            >
              <Check
                className={cn(
                  'size-3 text-muted-foreground',
                  isActive ? 'opacity-70' : 'opacity-0'
                )}
              />
              {renderOption ? renderOption(opt) : <span className="truncate">{opt.primary}</span>}
            </CommandItem>
          )
        })}
      </CommandList>
    </Command>
  )
}

export function MultiSelectList<O extends PickerOption>({
  options,
  selected,
  loading,
  error,
  searchPlaceholder,
  emptyText,
  renderOption,
  onChange
}: {
  options: O[]
  selected: string[]
  loading: boolean
  error: string | null
  searchPlaceholder: string
  emptyText?: string
  renderOption?: (opt: O) => React.ReactNode
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => filterTaskPickerOptions(options, query), [options, query])
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const { queryTooLarge } = getTaskPickerQueryState(query)
  const fallback = loading
    ? translate('auto.components.task.filter.pickers.96cc85e839', 'Loading…')
    : queryTooLarge
      ? translate('auto.components.task.filter.pickers.2c3b81720a', 'Search text is too large.')
      : (error ??
        emptyText ??
        translate('auto.components.task.filter.pickers.8776bc66db', 'No matches'))

  const toggle = (key: string): void => {
    const next = new Set(selectedSet)
    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
    }
    onChange([...next])
  }

  return (
    <Command shouldFilter={false}>
      <CommandInput
        placeholder={searchPlaceholder}
        value={query}
        onValueChange={setQuery}
        className="text-xs"
      />
      <CommandList>
        <CommandEmpty>{fallback}</CommandEmpty>
        {selected.length > 0 ? (
          <CommandItem
            value="__clear__"
            onSelect={() => onChange([])}
            className="gap-2 px-3 py-1.5 text-xs text-muted-foreground"
          >
            {translate('auto.components.task.filter.pickers.f7690f6c74', 'Clear ({{value0}})', {
              value0: selected.length
            })}
          </CommandItem>
        ) : null}
        {filtered.map((opt) => {
          const isActive = selectedSet.has(opt.key)
          return (
            <CommandItem
              key={opt.key}
              value={opt.key}
              onSelect={() => toggle(opt.key)}
              className="items-center gap-2 px-3 py-1.5 text-xs"
            >
              <Check
                className={cn(
                  'size-3 text-muted-foreground',
                  isActive ? 'opacity-70' : 'opacity-0'
                )}
              />
              {renderOption ? renderOption(opt) : <span className="truncate">{opt.primary}</span>}
            </CommandItem>
          )
        })}
      </CommandList>
    </Command>
  )
}
