import { useMemo, useState } from 'react'
import { Check, ChevronsUpDown, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { JiraEditField } from '../../../shared/jira/jira-types'
import { getJiraCreateAllowedValueLabel } from './task-page-jira-create-fields'
import { getJiraEditOptionKey } from './jira-issue-edit-field-drafts'

/**
 * Searchable picker over an edit field's allowedValues. Single mode commits on
 * select; multi mode collects toggles and commits once when the popover closes.
 */
export function JiraEditFieldOptionPicker({
  field,
  selected,
  multiple,
  pending,
  disabled,
  onCommit
}: {
  field: JiraEditField
  selected: string[]
  multiple: boolean
  pending: boolean
  disabled: boolean
  onCommit: (keys: string[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<string[]>(selected)
  const options = useMemo(
    () =>
      (field.allowedValues ?? [])
        .map((option) => ({
          key: getJiraEditOptionKey(option),
          label: getJiraCreateAllowedValueLabel(option)
        }))
        .filter((option) => option.key),
    [field.allowedValues]
  )
  const filtered = options.filter((option) =>
    option.label.toLowerCase().includes(query.trim().toLowerCase())
  )
  const current = open && multiple ? draft : selected
  const labels = options.filter((option) => current.includes(option.key)).map((o) => o.label)

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (nextOpen) {
      setDraft(selected)
      return
    }
    setQuery('')
    const changed = draft.length !== selected.length || draft.some((key) => !selected.includes(key))
    if (multiple && changed) {
      onCommit(draft)
    }
  }

  const choose = (key: string): void => {
    if (!multiple) {
      setOpen(false)
      setQuery('')
      if (key !== selected[0]) {
        onCommit(key ? [key] : [])
      }
      return
    }
    setDraft((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]))
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={field.name}
          disabled={disabled}
          className="h-8 w-full justify-between"
        >
          <span className={cn('truncate', labels.length === 0 && 'text-muted-foreground')}>
            {labels.length > 0 ? labels.join(', ') : translate('jira.editFields.none', 'None')}
          </span>
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ChevronsUpDown className="size-3.5 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(320px,calc(100vw-1rem))] min-w-[var(--radix-popover-trigger-width)]"
      >
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={translate('jira.editFields.searchOptions', 'Search options...')}
          />
          <CommandList>
            <CommandEmpty>
              {translate('jira.editFields.noOptions', 'No options match your search.')}
            </CommandEmpty>
            {!multiple && !field.required ? (
              <CommandItem value="__none__" onSelect={() => choose('')}>
                <Check
                  className={cn('size-3', current.length === 0 ? 'opacity-70' : 'opacity-0')}
                />
                {translate('jira.editFields.none', 'None')}
              </CommandItem>
            ) : null}
            {filtered.map((option) => (
              <CommandItem key={option.key} value={option.key} onSelect={() => choose(option.key)}>
                <Check
                  className={cn(
                    'size-3',
                    current.includes(option.key) ? 'opacity-70' : 'opacity-0'
                  )}
                />
                <span className="truncate">{option.label}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
