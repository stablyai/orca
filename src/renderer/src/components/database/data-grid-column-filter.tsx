import React, { useState } from 'react'
import { Filter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { DbColumnFilter, DbFilterOperator } from '../../../../shared/database-types'
import { DB_FILTER_OPERATORS, operatorTakesValue } from './data-grid-filters'

// Per-column filter control: a funnel button that opens a popover to pick an
// operator + value. Emits the predicate (or null to clear) to the caller, which
// folds it into the table's filter set and re-queries server-side.
export function DataGridColumnFilter({
  column,
  filter,
  onApply
}: {
  column: string
  filter?: DbColumnFilter
  onApply: (filter: DbColumnFilter | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [operator, setOperator] = useState<DbFilterOperator>(filter?.operator ?? '=')
  const [value, setValue] = useState(
    filter && 'value' in filter && filter.value != null ? String(filter.value) : ''
  )
  const active = !!filter

  const apply = (): void => {
    // is-null/is-not-null carry no value; the discriminated DbColumnFilter type
    // requires a value for every other operator, so build each variant explicitly.
    onApply(
      operatorTakesValue(operator)
        ? { column, operator: operator as Exclude<DbFilterOperator, 'is-null' | 'is-not-null'>, value }
        : { column, operator: operator as 'is-null' | 'is-not-null' }
    )
    setOpen(false)
  }
  const clear = (): void => {
    onApply(null)
    setOperator('=')
    setValue('')
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          // Stop the click from also triggering the header's sort toggle.
          onClick={(event) => event.stopPropagation()}
          aria-label={translate('auto.components.database.DataGridColumnFilter.filter', 'Filter column')}
          className={`flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-accent ${
            active
              ? 'text-primary'
              : 'text-muted-foreground/40 opacity-0 group-hover:opacity-100'
          }`}
        >
          <Filter className={`size-3 ${active ? 'fill-current' : ''}`} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-56 p-2"
        onClick={(event) => event.stopPropagation()}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            apply()
          }}
          className="flex flex-col gap-2"
        >
          <Select value={operator} onValueChange={(next) => setOperator(next as DbFilterOperator)}>
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DB_FILTER_OPERATORS.map((op) => (
                <SelectItem key={op.value} value={op.value} className="text-xs">
                  {op.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {operatorTakesValue(operator) ? (
            <Input
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="h-7 text-xs"
              placeholder={translate('auto.components.database.DataGridColumnFilter.value', 'Value')}
            />
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={clear}
              disabled={!active}
            >
              {translate('auto.components.database.DataGridColumnFilter.clear', 'Clear')}
            </Button>
            <Button type="submit" size="sm" className="h-7 text-xs">
              {translate('auto.components.database.DataGridColumnFilter.apply', 'Apply')}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
