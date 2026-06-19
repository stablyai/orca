import { SlidersHorizontal } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'

export type GlpiFilterValue = {
  text?: string
  category?: string
  priority?: number
}

export type GlpiFilterPopoverProps = {
  value: GlpiFilterValue
  onChange: (next: GlpiFilterValue) => void
  onClear: () => void
}

// Sentinel for the "Any priority" option: Radix Select rejects empty-string
// values, so we map it to the absence of a priority filter on both ends.
const ANY_PRIORITY = 'any'

function getPriorityOptions(): { value: number; label: string }[] {
  return [
    { value: 1, label: translate('auto.components.glpi.filter.popover.cb0205b0fc', 'Very low') },
    { value: 2, label: translate('auto.components.glpi.filter.popover.12d0381544', 'Low') },
    { value: 3, label: translate('auto.components.glpi.filter.popover.c63c887091', 'Medium') },
    { value: 4, label: translate('auto.components.glpi.filter.popover.3691c5f710', 'High') },
    { value: 5, label: translate('auto.components.glpi.filter.popover.5e0ef451f0', 'Very high') }
  ]
}

export function GlpiFilterPopover({
  value,
  onChange,
  onClear
}: GlpiFilterPopoverProps): React.JSX.Element {
  const activeCount =
    (value.text?.trim() ? 1 : 0) + (value.category?.trim() ? 1 : 0) + (value.priority ? 1 : 0)
  const hasActive = activeCount > 0

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 border-border/50 bg-transparent text-xs hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
        >
          <SlidersHorizontal className="size-4" />
          {translate('auto.components.glpi.filter.popover.01f20435c6', 'Filters')}
          {hasActive ? (
            <Badge variant="secondary" className="ml-0.5 h-4 min-w-4 px-1 text-[10px] leading-none">
              {activeCount}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="glpi-filter-text" className="text-xs text-muted-foreground">
              {translate('auto.components.glpi.filter.popover.a63bf42a12', 'Title contains')}
            </Label>
            <Input
              id="glpi-filter-text"
              value={value.text ?? ''}
              onChange={(event) => onChange({ ...value, text: event.target.value })}
              className="h-8 text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="glpi-filter-category" className="text-xs text-muted-foreground">
              {translate('auto.components.glpi.filter.popover.2c76dbbb28', 'Category')}
            </Label>
            <Input
              id="glpi-filter-category"
              value={value.category ?? ''}
              onChange={(event) => onChange({ ...value, category: event.target.value })}
              className="h-8 text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">
              {translate('auto.components.glpi.filter.popover.d5148b45bf', 'Priority')}
            </Label>
            <Select
              value={value.priority ? String(value.priority) : ANY_PRIORITY}
              onValueChange={(next) =>
                onChange({
                  ...value,
                  priority: next === ANY_PRIORITY ? undefined : Number(next)
                })
              }
            >
              <SelectTrigger size="sm" className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_PRIORITY}>
                  {translate('auto.components.glpi.filter.popover.1c19ea34de', 'Any')}
                </SelectItem>
                {getPriorityOptions().map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.value} {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={!hasActive}
            className="h-8 justify-start px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {translate('auto.components.glpi.filter.popover.58b7bc144d', 'Clear filters')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
