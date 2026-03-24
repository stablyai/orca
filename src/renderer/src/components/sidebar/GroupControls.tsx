import React from 'react'
import { ArrowUpAZ, ArrowUpDown, Check, Clock3, FolderTree } from 'lucide-react'
import { useAppStore } from '@/store'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const SORT_OPTIONS = {
  name: {
    label: 'Name',
    icon: ArrowUpAZ
  },
  recent: {
    label: 'Recent',
    icon: Clock3
  },
  repo: {
    label: 'Repo',
    icon: FolderTree
  }
} as const

const GroupControls = React.memo(function GroupControls() {
  const groupBy = useAppStore((s) => s.groupBy)
  const setGroupBy = useAppStore((s) => s.setGroupBy)
  const sortBy = useAppStore((s) => s.sortBy)
  const setSortBy = useAppStore((s) => s.setSortBy)
  const selectedSort = SORT_OPTIONS[sortBy]
  const SelectedSortIcon = selectedSort.icon

  return (
    <div className="flex items-center justify-between px-2 pb-1.5">
      <ToggleGroup
        type="single"
        value={groupBy}
        onValueChange={(v) => {
          if (v) {
            setGroupBy(v as typeof groupBy)
          }
        }}
        variant="outline"
        size="sm"
        className="h-6"
      >
        <ToggleGroupItem
          value="none"
          className="h-6 px-2 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
        >
          All
        </ToggleGroupItem>
        <ToggleGroupItem
          value="pr-status"
          className="h-6 px-2 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
        >
          PR Status
        </ToggleGroupItem>
        <ToggleGroupItem
          value="repo"
          className="h-6 px-2 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
        >
          Repo
        </ToggleGroupItem>
      </ToggleGroup>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="w-auto gap-1 px-1.5 text-muted-foreground"
                aria-label={`Sort by ${selectedSort.label}`}
              >
                <ArrowUpDown className="size-3" />
                <SelectedSortIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Sort by {selectedSort.label}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-0">
          {Object.entries(SORT_OPTIONS).map(([value, option]) => {
            const Icon = option.icon
            const isSelected = value === sortBy

            return (
              <DropdownMenuItem
                key={value}
                onSelect={() => setSortBy(value as typeof sortBy)}
                className="pr-7"
              >
                <Icon className="size-3.5" />
                <span>{option.label}</span>
                {isSelected ? <Check className="ml-auto size-3.5 text-foreground" /> : null}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

export default GroupControls
