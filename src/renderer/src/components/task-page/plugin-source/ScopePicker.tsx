import { useMemo, useState } from 'react'
import { Check, ChevronDown, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { PluginTaskScope } from '../../../../../shared/plugins/plugin-task-source-contract'
import type { PluginTaskSourceLoadError } from '@/store/slices/plugin-task-sources-slice-contract'
import {
  allProjectsLabel,
  describePluginTaskScopeSelection,
  filterPluginTaskScopes,
  togglePluginTaskScopeId
} from './scope-selection'

/** The scope controls travel together — a source either offers all of them or
 *  none — so they reach the query bar as one unit. */
export type PluginTaskSourceScopeFilter = {
  scopes: PluginTaskScope[]
  selectedScopeIds: string[]
  loading: boolean
  error: PluginTaskSourceLoadError | null
  onScopeIdsChange: (scopeIds: string[]) => void
}

export function TaskPagePluginSourceScopePicker({
  scopes,
  selectedScopeIds,
  loading,
  error,
  onScopeIdsChange
}: PluginTaskSourceScopeFilter): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [commandValue, setCommandValue] = useState('')
  const visibleScopes = useMemo(() => filterPluginTaskScopes(scopes, search), [scopes, search])
  const selected = useMemo(() => new Set(selectedScopeIds), [selectedScopeIds])

  // A failed listScopes must not read as "this source has no projects", so the
  // outage takes the picker's place instead of collapsing into an empty menu.
  // `status`, not `alert`: the item load reports the same outage as the page's
  // one assertive banner, and a second one would read as two failures.
  if (error) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role="status"
            className="flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-destructive/50 px-2 text-xs text-destructive"
          >
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">
              {translate(
                'auto.components.TaskPage.pluginTaskSourceScopesFailed',
                'Projects unavailable'
              )}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {error.message}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (loading) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled
        className="w-[180px] justify-start"
      >
        <span className="min-w-0 truncate">
          {translate(
            'auto.components.TaskPage.pluginTaskSourceScopesLoading',
            'Loading projects...'
          )}
        </span>
      </Button>
    )
  }

  if (scopes.length === 0) {
    return null
  }

  const searchLabel = translate(
    'auto.components.TaskPage.pluginTaskSourceScopeSearch',
    'Search projects...'
  )

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) {
          setSearch('')
          setCommandValue('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={translate('auto.components.TaskPage.pluginTaskSourceScopes', 'Projects')}
          className="w-[180px] shrink-0 justify-between"
        >
          <span className="min-w-0 truncate">
            {describePluginTaskScopeSelection(scopes, selectedScopeIds)}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(320px,calc(100vw-1rem))] min-w-[var(--radix-popover-trigger-width)]"
      >
        <Command shouldFilter={false} value={commandValue} onValueChange={setCommandValue}>
          <CommandInput
            autoFocus
            placeholder={searchLabel}
            value={search}
            onValueChange={setSearch}
          />
          <div className="border-b border-border py-1">
            <CommandItem value="__all-scopes__" onSelect={() => onScopeIdsChange([])}>
              <Check
                className={cn(
                  'size-3 text-muted-foreground',
                  selectedScopeIds.length === 0 ? 'opacity-70' : 'opacity-0'
                )}
              />
              <span>{allProjectsLabel()}</span>
            </CommandItem>
          </div>
          <CommandList>
            {visibleScopes.length === 0 ? (
              <div className="px-3 py-5 text-xs text-muted-foreground">
                {translate(
                  'auto.components.TaskPage.pluginTaskSourceScopesNoMatch',
                  'No projects match your search.'
                )}
              </div>
            ) : (
              visibleScopes.map((scope) => (
                <CommandItem
                  key={scope.id}
                  value={scope.id}
                  onSelect={() =>
                    onScopeIdsChange(togglePluginTaskScopeId(selectedScopeIds, scope.id))
                  }
                >
                  <Check
                    className={cn(
                      'size-3 text-muted-foreground',
                      selected.has(scope.id) ? 'opacity-70' : 'opacity-0'
                    )}
                  />
                  {/* `name` is rendered exactly as the source gave it: a future
                      provider need not use the "org / project" convention. */}
                  <span className="min-w-0 truncate">{scope.name}</span>
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
