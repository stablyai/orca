import {
  ArrowDownUp,
  Check,
  ChevronDown,
  LayoutGrid,
  List,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal
} from 'lucide-react'
import type { TrelloBoard, TrelloCardFilter, TrelloList } from '../../../shared/trello-types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TrelloIcon } from '@/components/icons/TrelloIcon'
import { cn } from '@/lib/utils'

export type TrelloGroupBy = 'board' | 'list' | 'none'
export type TrelloOrderBy = 'activity' | 'title' | 'due'
export type TrelloViewMode = 'list' | 'board'

const FILTER_OPTIONS: { id: TrelloCardFilter; label: string }[] = [
  { id: 'assigned', label: 'Assigned' },
  { id: 'allOpen', label: 'All open' },
  { id: 'archived', label: 'Archived' }
]

const TRELLO_VIEW_OPTIONS: { id: TrelloViewMode; label: string; Icon: typeof List }[] = [
  { id: 'list', label: 'List', Icon: List },
  { id: 'board', label: 'Board', Icon: LayoutGrid }
]

const TRELLO_GROUP_OPTIONS: { id: TrelloGroupBy; label: string }[] = [
  { id: 'board', label: 'Board' },
  { id: 'list', label: 'List' },
  { id: 'none', label: 'None' }
]

const TRELLO_ORDER_OPTIONS: { id: TrelloOrderBy; label: string }[] = [
  { id: 'activity', label: 'Last activity' },
  { id: 'title', label: 'Title' },
  { id: 'due', label: 'Due date' }
]

type TrelloTaskSourceControlsProps = {
  query: string
  onQueryChange: (query: string) => void
  boards: TrelloBoard[]
  boardLists: TrelloList[]
  selectedBoardId: string
  selectedBoardLabel: string
  onBoardChange: (boardId: string) => void
  selectedListId: string
  selectedListLabel: string
  onListChange: (listId: string) => void
  viewMode: TrelloViewMode
  onViewModeChange: (viewMode: TrelloViewMode) => void
  groupBy: TrelloGroupBy
  onGroupByChange: (groupBy: TrelloGroupBy) => void
  orderBy: TrelloOrderBy
  onOrderByChange: (orderBy: TrelloOrderBy) => void
  filter: TrelloCardFilter
  onFilterChange: (filter: TrelloCardFilter) => void
  loading: boolean
  onRefresh: () => void
  onCreate: () => void
}

export function TrelloTaskSourceControls({
  query,
  onQueryChange,
  boards,
  boardLists,
  selectedBoardId,
  selectedBoardLabel,
  onBoardChange,
  selectedListId,
  selectedListLabel,
  onListChange,
  viewMode,
  onViewModeChange,
  groupBy,
  onGroupByChange,
  orderBy,
  onOrderByChange,
  filter,
  onFilterChange,
  loading,
  onRefresh,
  onCreate
}: TrelloTaskSourceControlsProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/50 p-3">
      <div className="relative min-w-[220px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search Trello cards…"
          className="h-8 pl-8 text-xs"
        />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-8 max-w-[220px] items-center gap-2 rounded-md border border-border/50 bg-muted/50 px-2 text-xs font-medium text-foreground shadow-sm transition hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring/20"
          >
            <TrelloIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{selectedBoardLabel}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Boards</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => onBoardChange('all')}>
            <Check className={cn('size-3.5', selectedBoardId !== 'all' && 'opacity-0')} />
            All boards
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {boards.map((board) => (
            <DropdownMenuItem key={board.id} onSelect={() => onBoardChange(board.id)}>
              <Check className={cn('size-3.5', selectedBoardId !== board.id && 'opacity-0')} />
              <span className="truncate">{board.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {selectedBoardId !== 'all' ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-8 max-w-[200px] items-center gap-2 rounded-md border border-border/50 bg-muted/50 px-2 text-xs font-medium text-foreground shadow-sm transition hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring/20"
            >
              <List className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{selectedListLabel}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Lists</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onListChange('all')}>
              <Check className={cn('size-3.5', selectedListId !== 'all' && 'opacity-0')} />
              All lists
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {boardLists.map((list) => (
              <DropdownMenuItem key={list.id} onSelect={() => onListChange(list.id)}>
                <Check className={cn('size-3.5', selectedListId !== list.id && 'opacity-0')} />
                <span className="truncate">{list.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <div
        className="hidden items-center rounded-md border border-border/50 bg-background/70 p-0.5 md:flex"
        aria-label="Trello view mode"
      >
        {TRELLO_VIEW_OPTIONS.map(({ id, label, Icon }) => {
          const active = viewMode === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => onViewModeChange(id)}
              aria-label={`${label} view`}
              aria-pressed={active}
              className={cn(
                'inline-flex size-6 items-center justify-center rounded text-muted-foreground transition hover:text-foreground',
                active && 'bg-accent text-accent-foreground shadow-xs'
              )}
            >
              <Icon className="size-3.5" />
            </button>
          )
        })}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="xs"
            className="gap-1 border-border/50 bg-background/70 text-[11px]"
          >
            <SlidersHorizontal className="size-3.5" />
            View
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="flex items-center gap-2">
            <List className="size-3.5" />
            View
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={viewMode}
            onValueChange={(value) => onViewModeChange(value as TrelloViewMode)}
          >
            {TRELLO_VIEW_OPTIONS.map(({ id, label, Icon }) => (
              <DropdownMenuRadioItem key={id} value={id}>
                <Icon className="size-3.5" />
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="flex items-center gap-2">
            <SlidersHorizontal className="size-3.5" />
            Grouping
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={groupBy}
            onValueChange={(value) => onGroupByChange(value as TrelloGroupBy)}
          >
            {TRELLO_GROUP_OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option.id} value={option.id}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="flex items-center gap-2">
            <ArrowDownUp className="size-3.5" />
            Ordering
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={orderBy}
            onValueChange={(value) => onOrderByChange(value as TrelloOrderBy)}
          >
            {TRELLO_ORDER_OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option.id} value={option.id}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="flex items-center gap-1">
        {FILTER_OPTIONS.map((option) => (
          <Button
            key={option.id}
            variant={filter === option.id ? 'secondary' : 'ghost'}
            size="sm"
            className="h-8 text-xs"
            onClick={() => onFilterChange(option.id)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-8 cursor-pointer border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md disabled:pointer-events-auto disabled:cursor-wait supports-[backdrop-filter]:bg-transparent"
            onClick={onRefresh}
            disabled={loading}
            aria-label={loading ? 'Refreshing Trello cards' : 'Refresh Trello cards'}
          >
            {loading ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {loading ? 'Refreshing Trello cards…' : 'Refresh Trello cards'}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-8 border-border/50 bg-transparent hover:bg-muted/50 backdrop-blur-md supports-[backdrop-filter]:bg-transparent"
            onClick={onCreate}
            aria-label="New Trello card"
          >
            <Plus className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          New Trello card
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
