import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { searchRepos } from '@/lib/repo-search'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../shared/types'
import type { TaskProjectPickerGroup } from './task-page-default-repo-selection'
import {
  getSelectedTaskProjectSource,
  hasMultipleTaskProjectHosts,
  hasMultipleTaskProjectHostsInGroup,
  isTaskProjectGroupSelected,
  selectedTaskProjectGroups
} from './task-project-source-combobox-model'

type TaskProjectSourceStatus = {
  label: string
  title?: string
  disabled?: boolean
}

type TaskProjectSourceComboboxProps = {
  groups: TaskProjectPickerGroup[]
  selected: ReadonlySet<string>
  onChange: (next: ReadonlySet<string>) => void
  onSelectAll: () => void
  getRepoHostLabel?: (repo: Repo) => string | null | undefined
  getRepoSourceStatus?: (repo: Repo) => TaskProjectSourceStatus | null | undefined
  triggerClassName?: string
}

function renderTriggerLabel(
  groups: readonly TaskProjectPickerGroup[],
  selected: ReadonlySet<string>
): React.JSX.Element {
  if (groups.length === 0) {
    return (
      <span className="text-muted-foreground">
        {translate('auto.components.task.project.source.combobox.noProjects', 'No projects')}
      </span>
    )
  }
  const selectedProjectGroups = selectedTaskProjectGroups(groups, selected)
  if (selectedProjectGroups.length === groups.length) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {translate('auto.components.task.project.source.combobox.allProjects', 'All projects')}
      </span>
    )
  }
  const [first, second, ...rest] = selectedProjectGroups
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
      {first ? (
        <RepoBadgeLabel
          name={first.repo.displayName}
          color={first.repo.badgeColor}
          badgeClassName="size-1.5"
        />
      ) : null}
      {second ? <span className="text-muted-foreground">, {second.repo.displayName}</span> : null}
      {rest.length > 0 ? <span className="text-muted-foreground">+{rest.length}</span> : null}
    </span>
  )
}

function getProjectDetail(
  group: TaskProjectPickerGroup,
  selected: ReadonlySet<string>,
  showHostLabels: boolean,
  getRepoHostLabel?: (repo: Repo) => string | null | undefined
): string {
  const selectedSource = getSelectedTaskProjectSource(group, selected)
  const hostLabel = showHostLabels ? getRepoHostLabel?.(selectedSource)?.trim() : ''
  if (hasMultipleTaskProjectHostsInGroup(group)) {
    const hostCount = translate(
      'auto.components.task.project.source.combobox.hostCount',
      '{{value0}} hosts',
      {
        value0: String(group.sources.length)
      }
    )
    return hostLabel ? `${hostLabel} · ${hostCount}` : hostCount
  }
  return hostLabel ? `${hostLabel} · ${selectedSource.path}` : selectedSource.path
}

function getSourceDetail(repo: Repo, status?: TaskProjectSourceStatus | null): string {
  return status?.label ? `${repo.path} · ${status.label}` : repo.path
}

export default function TaskProjectSourceCombobox({
  groups,
  selected,
  onChange,
  onSelectAll,
  getRepoHostLabel,
  getRepoSourceStatus,
  triggerClassName
}: TaskProjectSourceComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [sourceMenuProjectKey, setSourceMenuProjectKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [commandValue, setCommandValue] = useState('')
  const sourceMenuCloseTimerRef = useRef<number | null>(null)
  const sourceMenuHoverRef = useRef<{
    projectKey: string | null
    row: boolean
    content: boolean
  }>({ projectKey: null, row: false, content: false })

  const filteredGroups = useMemo(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      return groups
    }
    return groups.filter((group) => searchRepos(group.sources, trimmed).length > 0)
  }, [groups, query])
  const showHostLabels = useMemo(() => hasMultipleTaskProjectHosts(groups), [groups])
  const allSelected =
    groups.length > 0 && selectedTaskProjectGroups(groups, selected).length === groups.length

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setQuery('')
      setSourceMenuProjectKey(null)
      sourceMenuHoverRef.current = { projectKey: null, row: false, content: false }
    }
  }, [])

  const clearSourceMenuCloseTimer = useCallback(() => {
    if (sourceMenuCloseTimerRef.current !== null) {
      window.clearTimeout(sourceMenuCloseTimerRef.current)
      sourceMenuCloseTimerRef.current = null
    }
  }, [])

  const setSourceMenuHover = useCallback(
    (projectKey: string, region: 'row' | 'content', hovered: boolean) => {
      clearSourceMenuCloseTimer()
      if (sourceMenuHoverRef.current.projectKey !== projectKey) {
        sourceMenuHoverRef.current = { projectKey, row: false, content: false }
      }
      sourceMenuHoverRef.current[region] = hovered
      if (hovered) {
        setSourceMenuProjectKey(projectKey)
        return
      }
      sourceMenuCloseTimerRef.current = window.setTimeout(() => {
        const hover = sourceMenuHoverRef.current
        if (hover.projectKey === projectKey && !hover.row && !hover.content) {
          setSourceMenuProjectKey((current) => (current === projectKey ? null : current))
          sourceMenuHoverRef.current = { projectKey: null, row: false, content: false }
        }
        sourceMenuCloseTimerRef.current = null
      }, 100)
    },
    [clearSourceMenuCloseTimer]
  )

  useEffect(() => clearSourceMenuCloseTimer, [clearSourceMenuCloseTimer])

  const toggleProject = useCallback(
    (group: TaskProjectPickerGroup) => {
      const next = new Set(selected)
      const selectedSource = group.sources.find((source) => next.has(source.id))
      if (selectedSource) {
        if (selectedTaskProjectGroups(groups, selected).length <= 1) {
          return
        }
        for (const source of group.sources) {
          next.delete(source.id)
        }
      } else {
        next.add(group.repo.id)
      }
      onChange(next)
    },
    [groups, onChange, selected]
  )

  const selectProjectSource = useCallback(
    (group: TaskProjectPickerGroup, source: Repo) => {
      const status = getRepoSourceStatus?.(source)
      if (status?.disabled) {
        return
      }
      const next = new Set(selected)
      for (const candidate of group.sources) {
        next.delete(candidate.id)
      }
      next.add(source.id)
      onChange(next)
      setSourceMenuProjectKey(null)
      sourceMenuHoverRef.current = { projectKey: null, row: false, content: false }
    },
    [getRepoSourceStatus, onChange, selected]
  )

  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      const first = groups[0]
      if (!first) {
        return
      }
      onChange(new Set([first.repo.id]))
      return
    }
    onSelectAll()
  }, [allSelected, groups, onChange, onSelectAll])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('h-8 w-full justify-between px-3 text-xs font-normal', triggerClassName)}
        >
          {renderTriggerLabel(groups, selected)}
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(360px,calc(100vw-1rem))] min-w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command shouldFilter={false} value={commandValue} onValueChange={setCommandValue}>
          <CommandInput
            autoFocus
            placeholder={translate(
              'auto.components.task.project.source.combobox.searchProjects',
              'Search projects...'
            )}
            value={query}
            onValueChange={setQuery}
            className="text-xs"
          />
          <div className="border-b border-border">
            <button
              type="button"
              onClick={handleSelectAll}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setCommandValue('')}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                allSelected && 'opacity-80'
              )}
            >
              <Check
                className={cn(
                  'size-3 text-muted-foreground',
                  allSelected ? 'opacity-70' : 'opacity-0'
                )}
              />
              <span>
                {translate(
                  'auto.components.task.project.source.combobox.allProjects',
                  'All projects'
                )}
              </span>
            </button>
          </div>
          <CommandList>
            {filteredGroups.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {translate(
                  'auto.components.task.project.source.combobox.noMatches',
                  'No projects match your search.'
                )}
              </div>
            ) : null}
            {filteredGroups.map((group) => {
              const selectedProject = isTaskProjectGroupSelected(group, selected)
              const selectedSource = getSelectedTaskProjectSource(group, selected)
              const detail = getProjectDetail(group, selected, showHostLabels, getRepoHostLabel)
              const hasSourceMenu = hasMultipleTaskProjectHostsInGroup(group)
              return (
                <div
                  key={group.projectKey}
                  onMouseEnter={() => {
                    setCommandValue(group.repo.id)
                    if (hasSourceMenu) {
                      setSourceMenuHover(group.projectKey, 'row', true)
                    }
                  }}
                  onMouseLeave={() => {
                    if (hasSourceMenu) {
                      setSourceMenuHover(group.projectKey, 'row', false)
                    }
                  }}
                  className={cn(
                    'group/source-row flex items-stretch transition-colors hover:bg-accent hover:text-accent-foreground',
                    commandValue === group.repo.id && 'bg-accent text-accent-foreground'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleProject(group)}
                    onMouseDown={(event) => event.preventDefault()}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs"
                  >
                    <Check
                      className={cn(
                        'size-3 text-muted-foreground',
                        selectedProject ? 'opacity-70' : 'opacity-0'
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <RepoBadgeLabel
                          name={group.repo.displayName}
                          color={group.repo.badgeColor}
                          className="max-w-full"
                        />
                      </span>
                      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{detail}</p>
                    </div>
                  </button>
                  {hasSourceMenu ? (
                    <Popover
                      open={sourceMenuProjectKey === group.projectKey}
                      onOpenChange={(nextOpen) =>
                        setSourceMenuProjectKey(nextOpen ? group.projectKey : null)
                      }
                    >
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          title={translate(
                            'auto.components.task.project.source.combobox.chooseSource',
                            'Choose task source'
                          )}
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                          }}
                          onMouseDown={(event) => event.preventDefault()}
                          className="flex w-8 shrink-0 items-center justify-center text-muted-foreground"
                        >
                          <ChevronRight className="size-3.5" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        side="right"
                        align="start"
                        sideOffset={6}
                        className="w-[min(280px,calc(100vw-1rem))] p-1"
                        onMouseEnter={() => setSourceMenuHover(group.projectKey, 'content', true)}
                        onMouseLeave={() => setSourceMenuHover(group.projectKey, 'content', false)}
                      >
                        <div className="py-1">
                          {group.sources.map((source) => {
                            const status = getRepoSourceStatus?.(source)
                            const sourceSelected = source.id === selectedSource.id
                            const sourceDetail = getSourceDetail(source, status)
                            return (
                              <button
                                key={source.id}
                                type="button"
                                disabled={status?.disabled}
                                title={status?.title}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => selectProjectSource(group, source)}
                                className={cn(
                                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground',
                                  status?.disabled && 'cursor-not-allowed opacity-50'
                                )}
                              >
                                <Check
                                  className={cn(
                                    'size-3 text-muted-foreground',
                                    sourceSelected ? 'opacity-70' : 'opacity-0'
                                  )}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-xs">
                                    {getRepoHostLabel?.(source) ?? source.displayName}
                                  </div>
                                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                                    {sourceDetail}
                                  </p>
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      </PopoverContent>
                    </Popover>
                  ) : null}
                </div>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
