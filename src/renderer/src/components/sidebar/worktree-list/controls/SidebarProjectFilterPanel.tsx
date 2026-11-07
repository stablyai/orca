import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Server, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import {
  addSidebarProjectGroup,
  removeSidebarProjectGroup,
  searchSidebarProjectGroups,
  type SidebarProjectFilterGroup
} from './sidebar-project-filter-groups'
import { translate } from '@/i18n/i18n'

function projectCommandFilter(_value: string, search: string, keywords?: string[]): number {
  const query = search.trim().toLowerCase()
  if (!query) {
    return 1
  }

  const [displayName = '', path = ''] = keywords ?? []
  const displayNameIndex = displayName.toLowerCase().indexOf(query)
  if (displayNameIndex !== -1) {
    return 2 + 1 / (displayNameIndex + 1)
  }

  const pathIndex = path.toLowerCase().indexOf(query)
  if (pathIndex !== -1) {
    return 1 + 1 / (pathIndex + 1)
  }

  return 0
}

type SidebarProjectFilterPanelProps = {
  availableGroups: SidebarProjectFilterGroup[]
  selectedGroups: SidebarProjectFilterGroup[]
  hasRepoFilter: boolean
  filterRepoIds: readonly string[]
  setFilterRepoIds: (ids: string[]) => void
}

/** Mount search state with the submenu so reopening cannot inherit a stale query. */
export function SidebarProjectFilterPanel({
  availableGroups,
  selectedGroups,
  hasRepoFilter,
  filterRepoIds,
  setFilterRepoIds
}: SidebarProjectFilterPanelProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [highlightedProjectKey, setHighlightedProjectKey] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Defer focus one frame until Radix’s root trap yields to the submenu; commit-time autofocus gets pulled back.
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  const handleSelectProject = useCallback(
    (group: SidebarProjectFilterGroup) => {
      setFilterRepoIds(addSidebarProjectGroup(filterRepoIds, group))
      setQuery('')
    },
    [filterRepoIds, setFilterRepoIds]
  )

  const handleRemoveProject = useCallback(
    (group: SidebarProjectFilterGroup) => {
      setFilterRepoIds(removeSidebarProjectGroup(filterRepoIds, group))
    },
    [filterRepoIds, setFilterRepoIds]
  )

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Keep search typing out of Radix menu typeahead.
      if (event.key === 'Backspace' && query === '' && selectedGroups.length > 0) {
        const lastGroup = selectedGroups.at(-1)
        if (lastGroup) {
          event.preventDefault()
          event.stopPropagation()
          handleRemoveProject(lastGroup)
        }
        return
      }

      if (event.key === 'Enter') {
        const highlightedGroup = availableGroups.find(
          (group) => group.projectKey === highlightedProjectKey
        )
        const group = highlightedGroup ?? searchSidebarProjectGroups(availableGroups, query)[0]
        if (group) {
          event.preventDefault()
          event.stopPropagation()
          handleSelectProject(group)
        }
        return
      }

      // Leave ArrowLeft to Radix at the start of the field so keyboard users can return to the parent menu.
      if (event.key === 'ArrowLeft') {
        const { selectionStart, selectionEnd } = event.currentTarget
        const caretAtStart = selectionStart === 0 && selectionEnd === 0
        if (!caretAtStart) {
          event.stopPropagation()
        }
        return
      }

      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
        event.stopPropagation()
      }
    },
    [
      availableGroups,
      handleRemoveProject,
      handleSelectProject,
      highlightedProjectKey,
      query,
      selectedGroups
    ]
  )

  return (
    <Command
      filter={projectCommandFilter}
      onValueChange={setHighlightedProjectKey}
      className="bg-transparent"
    >
      <SelectedProjectPills selectedGroups={selectedGroups} onRemoveProject={handleRemoveProject} />
      <CommandInput
        ref={inputRef}
        placeholder={
          selectedGroups.length > 0
            ? translate(
                'auto.components.sidebar.SidebarRepositoryFilterSection.5a273fbfce',
                'Add project...'
              )
            : translate(
                'auto.components.sidebar.SidebarRepositoryFilterSection.83a820fa71',
                'Filter projects...'
              )
        }
        value={query}
        onValueChange={setQuery}
        onKeyDown={handleInputKeyDown}
        className="h-8 py-2 text-xs"
        wrapperClassName="mx-1 rounded-[7px] border border-border/70 px-2"
        iconClassName="h-3.5 w-3.5"
      />
      <CommandList className="max-h-48 py-1">
        <CommandEmpty className="py-4 text-[11px]">
          {hasRepoFilter
            ? translate(
                'auto.components.sidebar.SidebarRepositoryFilterSection.bbbc6e8e3b',
                'No unselected projects match'
              )
            : translate(
                'auto.components.sidebar.SidebarRepositoryFilterSection.4815c70605',
                'No projects match'
              )}
        </CommandEmpty>
        {availableGroups.map((group) => {
          const { repo } = group
          return (
            <CommandItem
              key={group.projectKey}
              value={group.projectKey}
              keywords={[repo.displayName, repo.path]}
              onSelect={() => handleSelectProject(group)}
              className="mx-1 my-0.5 items-center gap-2 rounded-[7px] px-2 py-1 text-[12px] leading-5 font-medium data-[selected=true]:bg-black/8 dark:data-[selected=true]:bg-white/14"
            >
              <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                <RepoBadgeLabel
                  name={repo.displayName}
                  color={repo.badgeColor}
                  className="max-w-full"
                />
                {repo.connectionId && (
                  <span className="shrink-0 inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
                    <Server className="size-2.5" />
                    {translate(
                      'auto.components.sidebar.SidebarRepositoryFilterSection.2656053db4',
                      'SSH'
                    )}
                  </span>
                )}
              </span>
            </CommandItem>
          )
        })}
      </CommandList>
    </Command>
  )
}

function SelectedProjectPills({
  selectedGroups,
  onRemoveProject
}: {
  selectedGroups: SidebarProjectFilterGroup[]
  onRemoveProject: (group: SidebarProjectFilterGroup) => void
}) {
  if (selectedGroups.length === 0) {
    return null
  }

  return (
    <div className="scrollbar-sleek mx-1 mb-1 flex max-h-16 flex-wrap gap-1 overflow-y-auto rounded-[7px] border border-border/70 bg-muted/25 p-1">
      {selectedGroups.map((group) => (
        <Badge
          key={group.projectKey}
          variant="outline"
          className="h-5 max-w-full gap-1 border-border/70 bg-background px-1.5 py-0 text-[11px] font-medium"
        >
          <RepoBadgeLabel
            name={group.repo.displayName}
            color={group.repo.badgeColor}
            className="max-w-[8rem]"
            badgeClassName="size-1.5"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate(
              'auto.components.sidebar.SidebarRepositoryFilterSection.f10ca29601',
              'Remove {{value0}} filter',
              { value0: group.repo.displayName }
            )}
            className="-mr-1 size-4 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onRemoveProject(group)}
          >
            <X className="size-2.5" strokeWidth={2.5} />
          </Button>
        </Badge>
      ))}
    </div>
  )
}
