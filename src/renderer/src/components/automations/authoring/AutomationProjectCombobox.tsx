import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown, FolderPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { useAppStore } from '@/store/index'
import { isGitRepoKind } from '../../../../../shared/repository/repo-kind'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { isRepoSearchQueryTooLarge, searchRepos } from '@/lib/workspace/catalog/repo-search'
import { cn } from '@/lib/class-names'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { projectHostCountLabel } from '@/components/host-picker/project-host-count-label'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Bot } from '../../../../../shared/bot-types'
import {
  getAutomationProjectGroupForRepo,
  getAutomationProjectGroups,
  getAutomationProjectRepoDetail,
  hasMultipleAutomationProjectHosts,
  getAutomationProjectSelectedSource
} from './automation-project-groups'
import { AutomationProjectHostMenu } from './AutomationProjectHostMenu'
import { BotAvatar } from '@/components/bots/BotAvatar'
import { botTargetLabel } from './automation-bot-target-label'

type AutomationProjectComboboxProps = {
  repos: readonly Repo[]
  recordedProject?: { id: string; label: string }
  value: string
  onValueChange: (repoId: string) => void
  placeholder?: string
  triggerClassName?: string
  getRepoHostLabel?: (repo: Repo) => string | null | undefined
  allowAddProject?: boolean
  /** Bots offered as targets beside projects; choosing one runs the automation as that bot. */
  bots?: readonly Pick<Bot, 'id' | 'name' | 'avatar' | 'hostId'>[]
  selectedBotId?: string | null
  onBotChange?: (botId: string) => void
}

const NO_BOTS: readonly Pick<Bot, 'id' | 'name' | 'avatar' | 'hostId'>[] = []

export default function AutomationProjectCombobox({
  repos,
  recordedProject,
  value,
  onValueChange,
  placeholder = 'Select project',
  triggerClassName,
  getRepoHostLabel,
  allowAddProject = true,
  bots = NO_BOTS,
  selectedBotId = null,
  onBotChange
}: AutomationProjectComboboxProps): React.JSX.Element {
  const t = useTranslate()
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
  const recordedChoice =
    recordedProject && !repos.some((repo) => repo.id === recordedProject.id)
      ? recordedProject
      : null
  const selectedBot = bots.find((bot) => bot.id === selectedBotId) ?? null
  const selectedRepo =
    !selectedBot && selectedGroup ? getAutomationProjectSelectedSource(selectedGroup, value) : null
  const showHostLabels = useMemo(() => hasMultipleAutomationProjectHosts(repos), [repos])
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
  const filteredBots = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? bots.filter((bot) => bot.name.toLowerCase().includes(needle)) : bots
  }, [bots, query])

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

  const handleSelectBot = (botId: string): void => {
    onBotChange?.(botId)
    handleOpenChange(false)
  }

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
          {selectedBot ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <BotAvatar bot={selectedBot} className="size-4 rounded-[4px] text-3xs" />
              <span className="truncate">{botTargetLabel(selectedBot.name)}</span>
            </span>
          ) : recordedChoice?.id === value ? (
            recordedChoice.label
          ) : selectedRepo ? (
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
            placeholder={t(
              'auto.components.automations.AutomationProjectCombobox.search',
              'Search projects/folders...'
            )}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {recordedChoice ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleSelect(recordedChoice.id)}
              >
                {recordedChoice.label}
              </button>
            ) : null}
            {filteredGroups.length === 0 && filteredBots.length === 0 && !recordedChoice ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t(
                  'auto.components.automations.AutomationProjectCombobox.empty',
                  'No projects/folders match your search.'
                )}
              </div>
            ) : null}
            {filteredGroups.map((group) => {
              const selectedSource = getAutomationProjectSelectedSource(group, value)
              const selectedProject = group.sources.some((source) => source.id === value)
              const hasHostMenu = hasMultipleAutomationProjectHosts(group.sources)
              const hostLabel = showHostLabels ? getRepoHostLabel?.(selectedSource) : null
              const detail = hasHostMenu
                ? `${hostLabel?.trim() || getRepoExecutionHostId(selectedSource)} · ${projectHostCountLabel(group.sources.length, t)}`
                : getAutomationProjectRepoDetail(selectedSource, hostLabel)
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
                    <AutomationProjectHostMenu
                      sources={group.sources}
                      selectedSourceId={selectedSource.id}
                      open={hostMenuProjectKey === group.projectKey}
                      onOpenChange={(nextOpen) =>
                        setHostMenuProjectKey(nextOpen ? group.projectKey : null)
                      }
                      onHoverChange={(hovered) =>
                        setHostMenuHover(group.projectKey, 'content', hovered)
                      }
                      hostLabelOf={(source) =>
                        (showHostLabels ? getRepoHostLabel?.(source) : null) ??
                        getRepoExecutionHostId(source)
                      }
                      onSelect={handleSelect}
                    />
                  ) : null}
                </div>
              )
            })}
            {filteredBots.map((bot) => (
              <button
                key={bot.id}
                type="button"
                onClick={() => handleSelectBot(bot.id)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setCommandValue(bot.id)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground',
                  commandValue === bot.id && 'bg-accent text-accent-foreground'
                )}
              >
                <Check
                  className={cn(
                    'size-3 text-foreground',
                    bot.id === selectedBotId ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <BotAvatar bot={bot} className="size-4 rounded-[4px] text-3xs" />
                <span className="truncate">{botTargetLabel(bot.name)}</span>
              </button>
            ))}
          </CommandList>
          {allowAddProject ? (
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
                    ? t(
                        'auto.components.automations.AutomationProjectCombobox.adding',
                        'Adding project…'
                      )
                    : t(
                        'auto.components.automations.AutomationProjectCombobox.addProject',
                        'Add project'
                      )}
                </span>
              </Button>
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
