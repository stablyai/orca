import { useState } from 'react'
import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { YouTrackFieldSchema } from '../../../../shared/youtrack-types'

// Why a sentinel: cmdk needs a value per item, and option values are user data.
const CLEAR_ITEM_VALUE = '__orca_clear_field__'

function optionLabel(field: YouTrackFieldSchema, value: string): string {
  return field.options.find((option) => option.value === value)?.label ?? value
}

export function describeFieldValues(field: YouTrackFieldSchema, values: string[]): string {
  return values.length > 0
    ? values.map((value) => optionLabel(field, value)).join(', ')
    : (field.emptyText ?? '—')
}

export function YouTrackOptionPicker({
  field,
  values,
  onChange,
  pending = false,
  disabled = false
}: {
  field: YouTrackFieldSchema
  values: string[]
  onChange: (values: string[]) => void
  pending?: boolean
  disabled?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const choose = (value: string): void => {
    if (!field.multi) {
      setOpen(false)
      onChange([value])
      return
    }
    onChange(
      values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled || pending}
          className="flex w-full min-w-0 items-center justify-between gap-1 rounded-md px-1.5 py-1 text-left text-[12px] text-foreground transition hover:bg-accent disabled:opacity-60"
        >
          <span className={cn('truncate', values.length === 0 && 'text-muted-foreground')}>
            {describeFieldValues(field, values)}
          </span>
          {pending ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60" align="start">
        <Command>
          {field.options.length > 8 ? (
            <CommandInput autoFocus placeholder={translate('youtrack.fields.filter', 'Filter…')} />
          ) : null}
          <CommandList className="max-h-64">
            <CommandEmpty>
              {translate('youtrack.fields.noOptions', 'No matching values.')}
            </CommandEmpty>
            <CommandGroup>
              {!field.required ? (
                <CommandItem
                  value={CLEAR_ITEM_VALUE}
                  onSelect={() => {
                    setOpen(false)
                    onChange([])
                  }}
                >
                  <span className="text-muted-foreground">
                    {field.emptyText ?? translate('youtrack.fields.clear', 'Clear')}
                  </span>
                </CommandItem>
              ) : null}
              {field.options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label]}
                  onSelect={() => choose(option.value)}
                  className="justify-between"
                >
                  <span className="truncate">{option.label}</span>
                  {values.includes(option.value) ? <Check className="size-3" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function placeholderFor(field: YouTrackFieldSchema): string {
  if (field.kind === 'period') {
    return translate('youtrack.fields.periodPlaceholder', 'e.g. 2d 4h')
  }
  return field.emptyText ?? ''
}

/** A typed field: text, number, date, or period. */
export function YouTrackScalarInput({
  field,
  value,
  onChange,
  onCommit,
  onCancel,
  autoFocus = false,
  disabled = false
}: {
  field: YouTrackFieldSchema
  value: string
  onChange: (value: string) => void
  onCommit?: () => void
  onCancel?: () => void
  autoFocus?: boolean
  disabled?: boolean
}): React.JSX.Element {
  const inputType =
    field.kind === 'date'
      ? 'date'
      : field.kind === 'datetime'
        ? 'datetime-local'
        : field.kind === 'integer' || field.kind === 'float'
          ? 'number'
          : 'text'
  return (
    <Input
      type={inputType}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && onCommit) {
          event.preventDefault()
          onCommit()
        } else if (event.key === 'Escape' && onCancel) {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
      onBlur={onCommit}
      placeholder={placeholderFor(field)}
      autoFocus={autoFocus}
      disabled={disabled}
    />
  )
}

/** Shows a typed field's value; click to edit, Enter or blur to save, Esc to cancel. */
export function YouTrackInlineScalarEditor({
  field,
  value,
  pending,
  onSave
}: {
  field: YouTrackFieldSchema
  value: string
  pending: boolean
  onSave: (value: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft !== null) {
    return (
      <YouTrackScalarInput
        field={field}
        value={draft}
        onChange={setDraft}
        autoFocus
        onCancel={() => setDraft(null)}
        onCommit={() => {
          const next = draft
          setDraft(null)
          if (next.trim() !== value.trim()) {
            onSave(next)
          }
        }}
      />
    )
  }
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => setDraft(value)}
      className="flex w-full min-w-0 items-center justify-between gap-1 rounded-md px-1.5 py-1 text-left text-[12px] text-foreground transition hover:bg-accent disabled:opacity-60"
    >
      <span className={cn('truncate', !value && 'text-muted-foreground')}>
        {value || (field.emptyText ?? '—')}
      </span>
      {pending ? (
        <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
      ) : null}
    </button>
  )
}
