import React, { useState } from 'react'
import { Flame, LoaderCircle, RefreshCw, Search, X } from 'lucide-react'

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
import { cn } from '@/lib/utils'
import type { KanbanLane, KanbanTaskFilter } from '../../../../../shared/kanban-types'

export type TaskPageKanbanFiltersProps = {
  kanbanFilter: KanbanTaskFilter
  setKanbanFilter: (filter: KanbanTaskFilter) => void
  lanes: KanbanLane[]
  kanbanLoading: boolean
  refreshKanban: () => void
}

type KanbanRole = KanbanTaskFilter['role']
type KanbanDue = NonNullable<KanbanTaskFilter['due']> | undefined

const ROLE_OPTIONS: { id: KanbanRole; label: string }[] = [
  { id: 'executor', label: translate('auto.components.kanban.filter.executor', 'Executor') },
  { id: 'observer', label: translate('auto.components.kanban.filter.observer', 'Observer') },
  { id: 'creator', label: translate('auto.components.kanban.filter.creator', 'Creator') }
]

const DUE_OPTIONS: { id: KanbanDue; label: string }[] = [
  { id: undefined, label: translate('auto.components.kanban.filter.dueAny', 'Any due') },
  { id: 'overdue', label: translate('auto.components.kanban.filter.dueOverdue', 'Overdue') },
  { id: 'today', label: translate('auto.components.kanban.filter.dueToday', 'Today') },
  { id: 'week', label: translate('auto.components.kanban.filter.dueWeek', '7 days') },
  { id: 'none', label: translate('auto.components.kanban.filter.dueNone', 'No due') }
]

export function TaskPageKanbanFilters({
  kanbanFilter,
  setKanbanFilter,
  lanes,
  kanbanLoading,
  refreshKanban
}: TaskPageKanbanFiltersProps): React.JSX.Element {
  const [searchInput, setSearchInput] = useState(kanbanFilter.query ?? '')

  const applySearch = (query: string): void => {
    setKanbanFilter({ ...kanbanFilter, query: query.trim() || undefined })
  }

  return (
    <div className="rounded-md rounded-b-none border border-border/50 bg-muted/50 px-3 pt-2 pb-2 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {ROLE_OPTIONS.map((role) => {
            const active = kanbanFilter.role === role.id
            return (
              <button
                key={role.id}
                type="button"
                onClick={() => setKanbanFilter({ ...kanbanFilter, role: role.id })}
                aria-pressed={active}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs transition',
                  active
                    ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
                    : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
                )}
              >
                {role.label}
              </button>
            )
          })}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={refreshKanban}
                disabled={kanbanLoading}
                aria-label={translate(
                  'auto.components.kanban.filter.refresh',
                  'Refresh Kanban tasks'
                )}
                className="border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
              >
                {kanbanLoading ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.kanban.filter.refresh', 'Refresh Kanban tasks')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Select
          value={kanbanFilter.laneId ?? 'all'}
          onValueChange={(value) =>
            setKanbanFilter({
              ...kanbanFilter,
              laneId: value === 'all' ? undefined : value
            })
          }
        >
          <SelectTrigger className="h-8 w-[180px] rounded-md border-border/50 bg-background text-xs shadow-sm">
            <SelectValue
              placeholder={translate('auto.components.kanban.filter.allLanes', 'All lanes')}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {translate('auto.components.kanban.filter.allLanes', 'All lanes')}
            </SelectItem>
            {lanes.map((lane) => (
              <SelectItem key={lane.id} value={lane.id}>
                {lane.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={kanbanFilter.due ?? 'any'}
          onValueChange={(value) =>
            setKanbanFilter({
              ...kanbanFilter,
              due: value === 'any' ? undefined : (value as NonNullable<KanbanTaskFilter['due']>)
            })
          }
        >
          <SelectTrigger className="h-8 w-[130px] rounded-md border-border/50 bg-background text-xs shadow-sm">
            <SelectValue
              placeholder={translate('auto.components.kanban.filter.dueAny', 'Any due')}
            />
          </SelectTrigger>
          <SelectContent>
            {DUE_OPTIONS.map((option) => (
              <SelectItem key={option.id ?? 'any'} value={option.id ?? 'any'}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          onClick={() => setKanbanFilter({ ...kanbanFilter, urgent: !kanbanFilter.urgent })}
          aria-pressed={kanbanFilter.urgent === true}
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition',
            kanbanFilter.urgent
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
          )}
        >
          <Flame className="size-3.5" />
          {translate('auto.components.kanban.filter.urgent', 'Urgent')}
        </button>
        <button
          type="button"
          onClick={() =>
            setKanbanFilter({ ...kanbanFilter, includeDone: !kanbanFilter.includeDone })
          }
          aria-pressed={kanbanFilter.includeDone === true}
          className={cn(
            'flex h-8 items-center rounded-md border px-2.5 text-xs transition',
            kanbanFilter.includeDone
              ? 'border-border/50 bg-foreground/90 text-background backdrop-blur-md'
              : 'border-border/50 bg-transparent text-foreground hover:bg-muted/50'
          )}
        >
          {translate('auto.components.kanban.filter.includeDone', 'Include Done')}
        </button>
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                applySearch(searchInput)
              }
            }}
            placeholder={translate('auto.components.kanban.filter.search', 'Search tasks')}
            className="h-8 rounded-md border-border/50 bg-background pl-8 pr-8 text-xs"
          />
          {searchInput ? (
            <button
              type="button"
              aria-label={translate('auto.components.kanban.filter.clearSearch', 'Clear search')}
              onClick={() => {
                setSearchInput('')
                applySearch('')
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
