// Why: lower-level pickers used by PRFilterDropdowns. Split out so the parent
// stays under the per-file line cap and so each picker can be tested or reused
// independently of the qualifier-mapping logic.
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
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'

export type PickerOption = { key: string; primary: string; secondary?: string }

export const PULL_REQUEST_PICKER_QUERY_MAX_BYTES = 2 * 1024

export function isPullRequestPickerQueryTooLarge(
  query: string,
  maxBytes = PULL_REQUEST_PICKER_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function getPullRequestPickerQueryState(query: string): {
  queryTooLarge: boolean
  trimmedQuery: string
} {
  const queryTooLarge = isPullRequestPickerQueryTooLarge(query)
  return {
    queryTooLarge,
    trimmedQuery: queryTooLarge ? '' : query.trim()
  }
}

export function filterPullRequestPickerOptions(
  options: PickerOption[],
  query: string
): PickerOption[] {
  const { queryTooLarge, trimmedQuery } = getPullRequestPickerQueryState(query)
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

export function SingleSelectList({
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
  options: PickerOption[]
  activeValue: string | null
  loading: boolean
  error: string | null
  searchPlaceholder: string
  emptyText?: string
  renderOption?: (opt: PickerOption) => React.ReactNode
  // Why: PR authors and reviewers can be external contributors who aren't in
  // `listAssignableUsers` (repo collaborators only). Allowing a typed login as
  // a fallback lets the user filter by anyone GitHub recognizes.
  allowCustomValue?: boolean
  onSelect: (value: string | null) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => filterPullRequestPickerOptions(options, query), [options, query])
  const { queryTooLarge, trimmedQuery } = getPullRequestPickerQueryState(query)
  const showCustom =
    allowCustomValue &&
    trimmedQuery.length > 0 &&
    !queryTooLarge &&
    !filtered.some((o) => o.key.toLowerCase() === trimmedQuery.toLowerCase())
  const fallback = loading
    ? 'Loading…'
    : queryTooLarge
      ? 'Search text is too large.'
      : showCustom
        ? 'Press Enter to use the typed value.'
        : (error ?? emptyText ?? 'No matches')

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
              {translate('auto.components.github.PRFilterPickers.2d1f58eda6', 'Use')}
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
            {translate('auto.components.github.PRFilterPickers.472c12ae03', 'Clear')}
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

export function MultiSelectList({
  options,
  selected,
  loading,
  error,
  searchPlaceholder,
  emptyText,
  onChange
}: {
  options: PickerOption[]
  selected: string[]
  loading: boolean
  error: string | null
  searchPlaceholder: string
  emptyText?: string
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => filterPullRequestPickerOptions(options, query), [options, query])
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const { queryTooLarge } = getPullRequestPickerQueryState(query)
  const fallback = loading
    ? 'Loading…'
    : queryTooLarge
      ? 'Search text is too large.'
      : (error ?? emptyText ?? 'No matches')

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
            {translate('auto.components.github.PRFilterPickers.fdf387297c', 'Clear (')}
            {selected.length})
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
              <span className="truncate">{opt.primary}</span>
            </CommandItem>
          )
        })}
      </CommandList>
    </Command>
  )
}
