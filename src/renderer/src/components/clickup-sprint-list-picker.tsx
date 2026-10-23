import { useMemo, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { ClickUpList } from '../../../shared/clickup-types'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  clickUpSelectedListName,
  filterClickUpPickerSprints,
  groupClickUpPickerLists
} from './clickup-list-picker-model'
import type { ClickUpSprint, ClickUpSprintFolder } from './clickup-sprints'
import type { ClickUpSprintSelection } from './clickup-task-view-preferences'

function triggerLabel(
  selection: ClickUpSprintSelection,
  lists: readonly ClickUpList[],
  current: ClickUpSprint | null
): string {
  if (selection === 'current') {
    return current
      ? translate('auto.components.clickup.filters.currentSprintNamed', 'Current: {{name}}', {
          name: current.name
        })
      : translate('auto.components.clickup.filters.noCurrentSprint', 'No current sprint')
  }
  return selection === 'all'
    ? translate('auto.components.clickup.filters.allLists', 'All lists')
    : (clickUpSelectedListName(selection, lists) ??
        translate('auto.components.clickup.filters.sprintOrList', 'Sprint / List'))
}

function PickerRow({
  value,
  selected,
  label,
  detail,
  count,
  onSelect
}: {
  value: string
  selected: boolean
  label: string
  detail?: string
  count?: number | null
  onSelect: () => void
}): React.JSX.Element {
  return (
    <CommandItem value={value} onSelect={onSelect}>
      <Check
        className={cn('size-3 text-muted-foreground', selected ? 'opacity-80' : 'opacity-0')}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? <span className="shrink-0 text-[10px] text-primary">{detail}</span> : null}
      {count !== undefined && count !== null ? (
        <span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>
      ) : null}
    </CommandItem>
  )
}

// One picker for "what am I looking at": the current Sprint by default, any
// Sprint of one sprint Folder, or any other List in the Space. Search filters
// the cached hierarchy client-side; picking narrows tasks with list_ids[].
export function ClickUpSprintListPicker({
  lists,
  sprintFolders,
  sprintFolderId,
  onSprintFolderChange,
  sprints,
  current,
  selection,
  onSelectionChange
}: {
  lists: readonly ClickUpList[]
  sprintFolders: readonly ClickUpSprintFolder[]
  sprintFolderId: string | null
  onSprintFolderChange: (folderId: string) => void
  sprints: readonly ClickUpSprint[]
  current: ClickUpSprint | null
  selection: ClickUpSprintSelection
  onSelectionChange: (selection: ClickUpSprintSelection) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const visibleSprints = useMemo(() => filterClickUpPickerSprints(sprints, query), [query, sprints])
  const listGroups = useMemo(() => groupClickUpPickerLists(lists, query), [lists, query])
  const selectedListId = typeof selection === 'string' ? null : selection.listId
  const folderName = sprintFolders.find((folder) => folder.id === sprintFolderId)?.name

  const choose = (next: ClickUpSprintSelection): void => {
    onSelectionChange(next)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={translate('auto.components.clickup.filters.sprintOrList', 'Sprint / List')}
          className="max-w-[240px]"
        >
          <span className="truncate">{triggerLabel(selection, lists, current)}</span>
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(380px,calc(100vw-1rem))]">
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={translate(
              'auto.components.clickup.filters.searchSprintsLists',
              'Search sprints and lists'
            )}
          />
          {sprintFolders.length > 1 ? (
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {translate('auto.components.clickup.filters.sprintFolder', 'Sprint folder')}
              </span>
              <Select value={sprintFolderId ?? undefined} onValueChange={onSprintFolderChange}>
                <SelectTrigger size="sm" className="min-w-0 flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sprintFolders.map((folder) => (
                    <SelectItem key={folder.id} value={folder.id}>
                      {folder.name ??
                        translate('auto.components.clickup.filters.noFolder', 'No folder')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <CommandList>
            <CommandEmpty>
              {translate(
                'auto.components.clickup.filters.noSprintListMatch',
                'No sprints or lists match.'
              )}
            </CommandEmpty>
            {query ? null : (
              <CommandGroup>
                <PickerRow
                  value="current"
                  selected={selection === 'current'}
                  label={translate(
                    'auto.components.clickup.filters.currentSprint',
                    'Current sprint'
                  )}
                  detail={current?.name}
                  onSelect={() => choose('current')}
                />
                <PickerRow
                  value="all"
                  selected={selection === 'all'}
                  label={translate('auto.components.clickup.filters.allLists', 'All lists')}
                  onSelect={() => choose('all')}
                />
              </CommandGroup>
            )}
            {visibleSprints.length > 0 ? (
              <CommandGroup
                heading={
                  folderName
                    ? translate(
                        'auto.components.clickup.filters.sprintsIn',
                        'Sprints · {{folder}}',
                        {
                          folder: folderName
                        }
                      )
                    : translate('auto.components.clickup.filters.sprints', 'Sprints')
                }
              >
                {visibleSprints.map((sprint) => (
                  <PickerRow
                    key={sprint.listId}
                    value={`list:${sprint.listId}`}
                    selected={selectedListId === sprint.listId}
                    label={sprint.name}
                    detail={
                      sprint.listId === current?.listId
                        ? translate('auto.components.clickup.filters.currentBadge', 'Current')
                        : undefined
                    }
                    count={sprint.taskCount}
                    onSelect={() => choose({ listId: sprint.listId })}
                  />
                ))}
              </CommandGroup>
            ) : null}
            {listGroups.map((group) => (
              <CommandGroup
                key={group.folderId || 'folderless'}
                heading={
                  group.folderName ??
                  translate(
                    'auto.components.clickup.filters.folderlessLists',
                    'Lists without a folder'
                  )
                }
              >
                {group.lists.map((list) => (
                  <PickerRow
                    key={list.id}
                    value={`list:${list.id}`}
                    selected={selectedListId === list.id}
                    label={list.name}
                    count={list.taskCount}
                    onSelect={() => choose({ listId: list.id })}
                  />
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
