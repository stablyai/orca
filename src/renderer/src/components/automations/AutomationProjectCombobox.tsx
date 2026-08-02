import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight, ChevronsUpDown, FolderPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { useAppStore } from '@/store'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isRepoSearchQueryTooLarge, searchRepos } from '@/lib/repo-search'
import { cn } from '@/lib/utils'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../shared/types'
import {
  getAutomationProjectGroupForRepo,
  getAutomationProjectGroups,
  getAutomationProjectSelectedSource
} from './automation-project-groups'

type AutomationProjectComboboxProps = {
  repos: Repo[]
  value: string
  onValueChange: (repoId: string) => void
  placeholder?: string
  triggerClassName?: string
  getRepoHostLabel?: (repo: Repo) => string | null | undefined
}

function getRepoDetail(repo: Repo, hostLabel?: string | null): string {
  const label = hostLabel?.trim()
  return label ? `${label} · ${repo.path}` : repo.path
}

function hasMultipleHosts(repos: readonly Repo[]): boolean {
  const hostIds = new Set<string>()
  for (const repo of repos) {
    hostIds.add(getRepoExecutionHostId(repo))
    if (hostIds.size > 1) {
      return true
    }
  }
  return false
}

function hasMultipleHostsInGroup(sources: readonly Repo[]): boolean {
  return hasMultipleHosts(sources)
}

export default function AutomationProjectCombobox({
  repos,
  value,
  onValueChange,
  placeholder = 'Select project',
  triggerClassName,
  getRepoHostLabel
}: AutomationProjectComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [commandValue, setCommandValue] = useState('')
  const [hostMenuProjectKey, setHostMenuProjectKey] = useState<string | null>(null)
  const hostMenuCloseTimerRef = useRef<number | null>(null)
  const hostMenuHoverRef = useRef<{
    projectKey: string | null
    row: boolean
    content: boolean
  }>({ projectKey: null, row: false, content: false })
  const addRepo = useAppStore((s) => s.addRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const [isAdding, setIsAdding] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const focusFrameRef = useRef<number | null>(null)
  const mountedRef = useMountedRef()

  const groups = useMemo(() => getAutomationProjectGroups(repos, value), [repos, value])
  const selectedGroup = useMemo(
    () => getAutomationProjectGroupForRepo(groups, value),
    [groups, value]
  )
  const selectedRepo = selectedGroup
    ? getAutomationProjectSelectedSource(selectedGroup, value)
    : null
  const showHostLabels = useMemo(() => hasMultipleHosts(repos), [repos])
  const filteredGroups = useMemo(() => {
    if (isRepoSearchQueryTooLarge(query)) {
      return []
    }
    const trimmed = query.trim()
    if (!trimmed) {
      return groups
    }
    return groups.filter((group) => searchRepos(group.sources, trimmed).length > 0)
  }, [groups, query])

  const cancelFocusFrame = useCallback((): void => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current)
      focusFrameRef.current = null
    }
  }, [])

  const setInputNode = useCallback(
    (node: HTMLInputElement | null): void => {
      if (node === null) {
        cancelFocusFrame()
      }
      inputRef.current = node
    },
    [cancelFocusFrame]
  )

  const focusSearchInput = useCallback(() => {
    cancelFocusFrame()
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null
      inputRef.current?.focus()
    })
  }, [cancelFocusFrame])

  const clearHostMenuCloseTimer = useCallback(() => {
    if (hostMenuCloseTimerRef.current !== null) {
      window.clearTimeout(hostMenuCloseTimerRef.current)
      hostMenuCloseTimerRef.current = null
    }
  }, [])

  const resetHostMenuHover = useCallback(() => {
    hostMenuHoverRef.current = { projectKey: null, row: false, content: false }
  }, [])

  const setHostMenuHover = useCallback(
    (projectKey: string, region: 'row' | 'content', hovered: boolean) => {
      clearHostMenuCloseTimer()
      if (hostMenuHoverRef.current.projectKey !== projectKey) {
        hostMenuHoverRef.current = { projectKey, row: false, content: false }
      }
      hostMenuHoverRef.current[region] = hovered
      if (hovered) {
        setHostMenuProjectKey(projectKey)
        return
      }
      hostMenuCloseTimerRef.current = window.setTimeout(() => {
        const hover = hostMenuHoverRef.current
        if (hover.projectKey === projectKey && !hover.row && !hover.content) {
          setHostMenuProjectKey((current) => (current === projectKey ? null : current))
          resetHostMenuHover()
        }
        hostMenuCloseTimerRef.current = null
      }, 100)
    },
    [clearHostMenuCloseTimer, resetHostMenuHover]
  )

  useEffect(() => clearHostMenuCloseTimer, [clearHostMenuCloseTimer])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (nextOpen) {
        setCommandValue(value)
        return
      }
      cancelFocusFrame()
      setQuery('')
      setHostMenuProjectKey(null)
      resetHostMenuHover()
    },
    [cancelFocusFrame, resetHostMenuHover, value]
  )

  const handleSelect = useCallback(
    (repoId: string) => {
      onValueChange(repoId)
      setOpen(false)
      setQuery('')
      setHostMenuProjectKey(null)
      resetHostMenuHover()
    },
    [onValueChange, resetHostMenuHover]
  )

  const handleAddFolder = useCallback(async () => {
    if (isAdding) {
      return
    }
    setIsAdding(true)
    try {
      const repo = await addRepo()
      if (repo) {
        if (isGitRepoKind(repo)) {
          await fetchWorktrees(repo.id)
        }
        if (!mountedRef.current) {
          return
        }
        handleSelect(repo.id)
      }
    } finally {
      if (mountedRef.current) {
        setIsAdding(false)
      }
    }
  }, [addRepo, fetchWorktrees, handleSelect, isAdding, mountedRef])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'h-8 min-w-[184px] justify-between px-3 text-xs font-normal',
            triggerClassName
          )}
        >
          {selectedRepo ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <RepoBadgeLabel
                name={selectedRepo.displayName}
                color={selectedRepo.badgeColor}
                badgeClassName="size-1.5"
              />
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[16rem] p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          focusSearchInput()
        }}
      >
        <Command shouldFilter={false} value={commandValue} onValueChange={setCommandValue}>
          <CommandInput
            ref={setInputNode}
            placeholder={translate(
              'auto.components.automations.AutomationProjectCombobox.search',
              'Search projects/folders...'
            )}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {filteredGroups.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {translate(
                  'auto.components.automations.AutomationProjectCombobox.empty',
                  'No projects/folders match your search.'
                )}
              </div>
            ) : null}
            {filteredGroups.map((group) => {
              const selectedSource = getAutomationProjectSelectedSource(group, value)
              const selectedProject = group.sources.some((source) => source.id === value)
              const hasHostMenu = hasMultipleHostsInGroup(group.sources)
              const hostLabel = showHostLabels ? getRepoHostLabel?.(selectedSource) : null
              const detail = hasHostMenu
                ? `${hostLabel?.trim() || getRepoExecutionHostId(selectedSource)} · ${group.sources.length} hosts`
                : getRepoDetail(selectedSource, hostLabel)
              return (
                <div
                  key={group.projectKey}
                  onMouseEnter={() => {
                    setCommandValue(group.repo.id)
                    if (hasHostMenu) {
                      setHostMenuHover(group.projectKey, 'row', true)
                    }
                  }}
                  onMouseLeave={() => {
                    if (hasHostMenu) {
                      setHostMenuHover(group.projectKey, 'row', false)
                    }
                  }}
                  className={cn(
                    'group/automation-project-row flex items-stretch transition-colors hover:bg-accent hover:text-accent-foreground',
                    commandValue === group.repo.id && 'bg-accent text-accent-foreground'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSelect(selectedSource.id)}
                    onMouseDown={(event) => event.preventDefault()}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs"
                  >
                    <Check
                      className={cn(
                        'size-3 text-foreground',
                        selectedProject ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <RepoBadgeLabel
                        name={group.repo.displayName}
                        color={group.repo.badgeColor}
                        className="max-w-full"
                      />
                      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{detail}</p>
                    </div>
                  </button>
                  {hasHostMenu ? (
                    <Popover
                      open={hostMenuProjectKey === group.projectKey}
                      onOpenChange={(nextOpen) =>
                        setHostMenuProjectKey(nextOpen ? group.projectKey : null)
                      }
                    >
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          title={translate(
                            'auto.components.automations.AutomationProjectCombobox.chooseHost',
                            'Choose automation host'
                          )}
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                          }}
                          onMouseDown={(event) => event.preventDefault()}
                          className="flex w-7 shrink-0 items-center justify-center text-muted-foreground"
                        >
                          <ChevronRight className="size-3.5" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        side="right"
                        align="start"
                        sideOffset={6}
                        className="w-[min(260px,calc(100vw-1rem))] p-1"
                        onMouseEnter={() => setHostMenuHover(group.projectKey, 'content', true)}
                        onMouseLeave={() => setHostMenuHover(group.projectKey, 'content', false)}
                      >
                        <div className="py-1">
                          {group.sources.map((source) => {
                            const sourceHostLabel = showHostLabels
                              ? getRepoHostLabel?.(source)
                              : null
                            const sourceSelected = source.id === selectedSource.id
                            return (
                              <button
                                key={source.id}
                                type="button"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => handleSelect(source.id)}
                                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                              >
                                <Check
                                  className={cn(
                                    'size-3 text-muted-foreground',
                                    sourceSelected ? 'opacity-70' : 'opacity-0'
                                  )}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-xs">
                                    {sourceHostLabel ?? getRepoExecutionHostId(source)}
                                  </div>
                                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                                    {source.path}
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
          <div className="border-t border-border">
            <Button
              type="button"
              variant="ghost"
              disabled={isAdding}
              onClick={() => void handleAddFolder()}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setCommandValue('')}
              className="h-8 w-full justify-start rounded-none px-3 text-xs font-normal"
            >
              <FolderPlus className="size-3.5 text-muted-foreground" />
              <span>
                {isAdding
                  ? translate(
                      'auto.components.automations.AutomationProjectCombobox.adding',
                      'Adding project…'
                    )
                  : translate(
                      'auto.components.automations.AutomationProjectCombobox.addProject',
                      'Add project'
                    )}
              </span>
            </Button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
