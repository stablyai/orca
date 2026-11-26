import React, { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'

function scopeCommandFilter(_value: string, search: string, keywords?: string[]): number {
  const query = search.trim().toLowerCase()
  if (!query) {
    return 1
  }

  const [label = '', detail = ''] = keywords ?? []
  const labelIndex = label.toLowerCase().indexOf(query)
  if (labelIndex !== -1) {
    return 2 + 1 / (labelIndex + 1)
  }

  const detailIndex = detail.toLowerCase().indexOf(query)
  return detailIndex === -1 ? 0 : 1 + 1 / (detailIndex + 1)
}

type SidebarScopeFilterMenuProps<Option extends { id: string }> = {
  title: string
  visibilityLabel: string
  placeholders: { filter: string; add: string }
  emptyMessages: { unfiltered: string; filtered: string }
  options: readonly Option[]
  selectedIds: readonly Option['id'][]
  onChange: (ids: Option['id'][]) => void
  getLabel: (option: Option) => string
  getSearchDetail?: (option: Option) => string
  findFirstMatch?: (options: Option[], query: string) => Option | undefined
  renderOption: (option: Option, selected: boolean) => React.ReactNode
  preserveWorkspaceBoardOpen?: boolean
}

export function SidebarScopeFilterMenu<Option extends { id: string }>(
  props: SidebarScopeFilterMenuProps<Option>
): React.JSX.Element {
  const t = useTranslate()
  const { title, visibilityLabel, options, selectedIds, onChange, preserveWorkspaceBoardOpen } =
    props
  const selected = new Set(selectedIds)
  const selectedOptions = options.filter((option) => selected.has(option.id))
  const availableOptions = options.filter((option) => !selected.has(option.id))

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between gap-3">
          <span>{title}</span>
          <span className="min-w-0 truncate text-2xs font-medium text-muted-foreground">
            {visibilityLabel}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-64"
        data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      >
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-2xs font-semibold text-muted-foreground">
            {title}
            {selectedOptions.length > 0 && (
              <span className="ml-1.5 font-medium text-foreground">· {selectedOptions.length}</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => onChange([])}
            className="rounded-full px-2 py-0.5 text-2xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent"
            disabled={selectedOptions.length === 0}
          >
            {t('auto.components.sidebar.SidebarRepositoryFilterSection.d3a9c4cea1', 'Clear')}
          </button>
        </div>
        <SidebarScopeFilterPanel
          {...props}
          availableOptions={availableOptions}
          selectedOptions={selectedOptions}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** Mount search state with the submenu so reopening cannot inherit a stale query. */
function SidebarScopeFilterPanel<Option extends { id: string }>({
  availableOptions,
  selectedOptions,
  selectedIds,
  onChange,
  placeholders,
  emptyMessages,
  getLabel,
  getSearchDetail,
  findFirstMatch,
  renderOption
}: SidebarScopeFilterMenuProps<Option> & {
  availableOptions: Option[]
  selectedOptions: Option[]
}): React.JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [highlightedId, setHighlightedId] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const hasSelection = selectedOptions.length > 0

  // Defer focus one frame until Radix's root trap yields to the submenu.
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  const selectOption = (id: Option['id']): void => {
    if (!selectedIds.includes(id)) {
      onChange([...selectedIds, id])
    }
    setQuery('')
  }

  const removeOption = (id: Option['id']): void => {
    onChange(selectedIds.filter((selectedId) => selectedId !== id))
  }

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // Keep search typing out of Radix menu typeahead.
    if (event.key === 'Backspace' && query === '' && hasSelection) {
      const lastOption = selectedOptions.at(-1)
      if (lastOption) {
        event.preventDefault()
        event.stopPropagation()
        removeOption(lastOption.id)
      }
      return
    }

    if (event.key === 'Enter') {
      const highlighted = availableOptions.find((option) => option.id === highlightedId)
      const next =
        highlighted ??
        (findFirstMatch
          ? findFirstMatch(availableOptions, query)
          : availableOptions.find((option) =>
              scopeCommandFilter(option.id, query, [getLabel(option)])
            ))
      if (next) {
        event.preventDefault()
        event.stopPropagation()
        selectOption(next.id)
      }
      return
    }

    if (event.key === 'ArrowLeft') {
      const { selectionStart, selectionEnd } = event.currentTarget
      if (selectionStart !== 0 || selectionEnd !== 0) {
        event.stopPropagation()
      }
      return
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      event.stopPropagation()
    }
  }

  return (
    <Command
      filter={scopeCommandFilter}
      onValueChange={setHighlightedId}
      surface="inline"
      density="menu"
    >
      {hasSelection && (
        <div className="scrollbar-sleek mx-1 mb-1 flex max-h-16 flex-wrap gap-1 overflow-y-auto rounded-[7px] border border-border/70 bg-muted/25 p-1">
          {selectedOptions.map((option) => (
            <Badge key={option.id} variant="outline" className="max-w-full">
              {renderOption(option, true)}
              <Button
                type="button"
                variant="ghost"
                size="chip"
                aria-label={t(
                  'auto.components.sidebar.SidebarRepositoryFilterSection.f10ca29601',
                  'Remove {{value0}} filter',
                  { value0: getLabel(option) }
                )}
                className="-mr-1"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => removeOption(option.id)}
              >
                <X />
              </Button>
            </Badge>
          ))}
        </div>
      )}
      <CommandInput
        ref={inputRef}
        variant="framed"
        placeholder={hasSelection ? placeholders.add : placeholders.filter}
        value={query}
        onValueChange={setQuery}
        onKeyDown={handleInputKeyDown}
        wrapperClassName="mx-1"
      />
      <CommandList className="my-1 max-h-48">
        <CommandEmpty>
          {hasSelection ? emptyMessages.filtered : emptyMessages.unfiltered}
        </CommandEmpty>
        {availableOptions.map((option) => (
          <CommandItem
            key={option.id}
            value={option.id}
            keywords={[getLabel(option), getSearchDetail?.(option) ?? '']}
            onSelect={() => selectOption(option.id)}
            selection="menu"
            density="menu"
            className="mx-1 my-0.5"
          >
            {renderOption(option, false)}
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  )
}
