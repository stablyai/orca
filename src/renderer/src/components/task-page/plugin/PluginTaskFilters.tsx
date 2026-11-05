import type React from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { PluginTaskListState } from './use-plugin-task-list'
import { selectedFilterValue } from './plugin-task-filter-selection'

// Why: Radix Select reserves '' for "no value", so an option meaning "all" travels encoded.
const EMPTY_OPTION_VALUE = '__plugin-task-filter-empty__'

export function PluginTaskFilters({
  title,
  list
}: {
  title: string
  list: PluginTaskListState
}): React.JSX.Element {
  const filters = list.result?.filters ?? []
  const refreshLabel = translate(
    'auto.components.TaskPage.pluginTaskRefresh',
    'Refresh {{value0}}',
    {
      value0: title
    }
  )
  return (
    <div className="rounded-md rounded-b-none border border-border/50 bg-muted/50 px-3 py-2 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[240px] flex-1">
          <Input
            value={list.searchInput}
            onChange={(event) => list.setSearchInput(event.target.value)}
            placeholder={translate(
              'auto.components.TaskPage.pluginTaskSearch',
              'Search {{value0}}',
              {
                value0: title
              }
            )}
            aria-label={translate(
              'auto.components.TaskPage.pluginTaskSearch',
              'Search {{value0}}',
              {
                value0: title
              }
            )}
          />
        </div>
        {filters.map((filter) => {
          const value = selectedFilterValue(filter, list.filters[filter.id])
          return (
            <Select
              key={filter.id}
              value={value === '' ? EMPTY_OPTION_VALUE : value}
              onValueChange={(next) =>
                list.setFilter(filter.id, next === EMPTY_OPTION_VALUE ? '' : next)
              }
            >
              <SelectTrigger aria-label={filter.label}>
                <span className="text-muted-foreground">{filter.label}:</span>
                <SelectValue />
              </SelectTrigger>
              {/* Why popper: item-aligned can lift long lists under the titlebar window controls. */}
              <SelectContent position="popper" side="bottom" align="end" sideOffset={4}>
                {filter.options.map((option) => (
                  <SelectItem
                    key={option.value || EMPTY_OPTION_VALUE}
                    value={option.value === '' ? EMPTY_OPTION_VALUE : option.value}
                  >
                    {option.count === undefined
                      ? option.label
                      : `${option.label} (${option.count})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
        })}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={list.refresh}
              disabled={list.loading}
              aria-label={refreshLabel}
            >
              {list.loading ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {refreshLabel}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
