import React, { useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { cn } from '@/lib/class-names'
import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard/clipboard-text'

export type PickerOption = { key: string; primary: string; secondary?: string }

export const PULL_REQUEST_PICKER_QUERY_MAX_BYTES = 2 * 1024

function isPullRequestPickerQueryTooLarge(
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

function pickerFallbackText(
  {
    customValue,
    loading,
    queryTooLarge,
    error,
    emptyText
  }: {
    customValue: string | null
    loading: boolean
    queryTooLarge: boolean
    error: string | null
    emptyText?: string
  },
  t: Translate = translate
): string {
  if (customValue) {
    return t(
      'auto.components.github.PRFilterPickers.pressEnterToUseValue',
      'Press Enter to use the typed value.'
    )
  }
  if (loading) {
    return t('auto.components.github.PRFilterPickers.loading', 'Loading…')
  }
  if (queryTooLarge) {
    return t(
      'auto.components.github.PRFilterPickers.searchTextTooLarge',
      'Search text is too large.'
    )
  }
  return error ?? emptyText ?? t('auto.components.github.PRFilterPickers.noMatches', 'No matches')
}

// Allow external authors/reviewers missing from the collaborator-only assignable-user list.
function customPickerValue(
  filtered: PickerOption[],
  { queryTooLarge, trimmedQuery }: ReturnType<typeof getPullRequestPickerQueryState>,
  allowCustomValue: boolean | undefined
): string | null {
  const show =
    allowCustomValue &&
    trimmedQuery.length > 0 &&
    !queryTooLarge &&
    !filtered.some((o) => o.key.toLowerCase() === trimmedQuery.toLowerCase())
  return show ? trimmedQuery : null
}

function CustomValueItem({
  value,
  onSelect
}: {
  value: string
  onSelect: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <CommandItem
      value={`__custom__:${value}`}
      onSelect={onSelect}
      className="items-center gap-2 px-3 py-1.5 text-xs"
    >
      <span className="min-w-0 truncate text-muted-foreground">
        <Trans
          i18n={i18n}
          defaults={t('auto.components.github.PRFilterPickers.useTypedValue', 'Use <value/>')}
          components={{
            value: <span className="font-medium text-foreground">{value}</span>
          }}
        />
      </span>
    </CommandItem>
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
  allowCustomValue?: boolean
  onSelect: (value: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => filterPullRequestPickerOptions(options, query), [options, query])
  const queryState = getPullRequestPickerQueryState(query)
  const { queryTooLarge } = queryState
  const customValue = customPickerValue(filtered, queryState, allowCustomValue)
  const fallback = pickerFallbackText({ customValue, loading, queryTooLarge, error, emptyText }, t)

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
        {customValue ? (
          <CustomValueItem value={customValue} onSelect={() => onSelect(customValue)} />
        ) : null}
        {activeValue ? (
          <CommandItem
            value="__clear__"
            onSelect={() => onSelect(null)}
            className="gap-2 px-3 py-1.5 text-xs text-muted-foreground"
          >
            {t('auto.components.github.PRFilterPickers.472c12ae03', 'Clear')}
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
  renderOption,
  allowCustomValue,
  onChange
}: {
  options: PickerOption[]
  selected: string[]
  loading: boolean
  error: string | null
  searchPlaceholder: string
  emptyText?: string
  renderOption?: (opt: PickerOption) => React.ReactNode
  allowCustomValue?: boolean
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => filterPullRequestPickerOptions(options, query), [options, query])
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const queryState = getPullRequestPickerQueryState(query)
  const { queryTooLarge } = queryState
  const customValue = customPickerValue(filtered, queryState, allowCustomValue)
  const fallback = pickerFallbackText({ customValue, loading, queryTooLarge, error, emptyText }, t)

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
        {customValue ? (
          <CustomValueItem value={customValue} onSelect={() => toggle(customValue)} />
        ) : null}
        {selected.length > 0 ? (
          <CommandItem
            value="__clear__"
            onSelect={() => onChange([])}
            className="gap-2 px-3 py-1.5 text-xs text-muted-foreground"
          >
            {t('auto.components.github.PRFilterPickers.clearSelected', 'Clear ({{count}})', {
              count: selected.length
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
