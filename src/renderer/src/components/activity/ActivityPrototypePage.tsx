/* eslint-disable max-lines -- Why: this prototype keeps the real-data adapter
and current visual skeleton together until the next refinement pass decides
which pieces become production modules. */
import React, { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Bell,
  BellDot,
  BellOff,
  GitBranch,
  MessageSquareText,
  Plus,
  Search,
  Settings
} from 'lucide-react'

import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { AgentStateDot, agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'
import type {
  AgentStatusEntry,
  AgentStatusState,
  AgentType
} from '../../../../shared/agent-status-types'

type ThreadReadFilter = 'all' | 'unread'
type ActivityDensity = 'compact' | 'comfortable'

type AgentActivityEvent = {
  id: string
  kind: 'agent'
  state: Extract<AgentStatusState, 'done' | 'blocked' | 'waiting'>
  timestamp: number
  worktree: Worktree
  repo: Repo | null
  entry: AgentStatusEntry
  tab: TerminalTab
  agentType: AgentType
  agentAlive: boolean
  unread: boolean
}

type WorktreeActivityEvent = {
  id: string
  kind: 'worktree-created'
  timestamp: number
  worktree: Worktree
  repo: Repo | null
  unread: boolean
}

type ActivityEvent = AgentActivityEvent | WorktreeActivityEvent

type WorktreeThread = {
  worktree: Worktree
  repo: Repo | null
  latestEvent: ActivityEvent
  events: ActivityEvent[]
  unread: boolean
}

const absoluteDateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

function formatAbsoluteDate(timestamp: number): string {
  return absoluteDateFormatter.format(new Date(timestamp))
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = timestamp - Date.now()
  const diffMinutes = Math.round(diffMs / 60_000)
  if (Math.abs(diffMinutes) < 60) {
    return relativeTimeFormatter.format(diffMinutes, 'minute')
  }
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return relativeTimeFormatter.format(diffHours, 'hour')
  }
  const diffDays = Math.round(diffHours / 24)
  return relativeTimeFormatter.format(diffDays, 'day')
}

function asDotState(state: AgentStatusState): AgentDotState {
  if (state === 'blocked' || state === 'waiting' || state === 'done') {
    return state
  }
  return 'idle'
}

function paneIdFromPaneKey(paneKey: string): number | null {
  const colon = paneKey.indexOf(':')
  const tail = colon > 0 ? paneKey.slice(colon + 1) : ''
  const parsed = /^\d+$/.test(tail) ? Number.parseInt(tail, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function agentTitle(event: AgentActivityEvent): string {
  if (event.state === 'done') {
    return event.entry.interrupted ? 'Agent interrupted' : 'Agent finished'
  }
  return event.state === 'waiting' ? 'Agent waiting for input' : 'Agent needs input'
}

function agentSummary(event: AgentActivityEvent): string {
  const prompt = event.entry.prompt.trim()
  if (event.state === 'done') {
    const message = event.entry.lastAssistantMessage?.trim()
    return message || prompt || 'Completed the current turn.'
  }
  return prompt || event.entry.lastAssistantMessage?.trim() || 'The agent paused for user input.'
}

function agentMeta(event: AgentActivityEvent): string {
  const agent = formatAgentTypeLabel(event.agentType)
  if (event.state === 'done') {
    return event.entry.interrupted ? `${agent} interrupted` : `${agent} completed`
  }
  return event.state === 'waiting' ? `${agent} waiting` : `${agent} blocked`
}

function eventTitle(event: ActivityEvent): string {
  return event.kind === 'agent' ? agentTitle(event) : 'Worktree created'
}

function eventSummary(event: ActivityEvent): string {
  return event.kind === 'agent' ? agentSummary(event) : event.worktree.displayName
}

function eventMeta(event: ActivityEvent): string {
  if (event.kind === 'agent') {
    return agentMeta(event)
  }
  return event.worktree.branch
}

function buildActivityEvents(args: {
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  tabsByWorktree: Record<string, TerminalTab[]>
  worktreeMap: Map<string, Worktree>
  repoMap: Map<string, Repo>
  acknowledgedAgentsByPaneKey: Record<string, number>
  locallyReadEventIds: Set<string>
}): ActivityEvent[] {
  const events: ActivityEvent[] = []
  const tabContext = new Map<string, { worktree: Worktree; tab: TerminalTab }>()

  for (const worktree of args.worktreeMap.values()) {
    const tabs = args.tabsByWorktree[worktree.id] ?? []
    for (const tab of tabs) {
      tabContext.set(tab.id, { worktree, tab })
    }
    if (worktree.createdAt) {
      const id = `worktree-created:${worktree.id}`
      events.push({
        id,
        kind: 'worktree-created',
        timestamp: worktree.createdAt,
        worktree,
        repo: args.repoMap.get(worktree.repoId) ?? null,
        unread: worktree.isUnread && !args.locallyReadEventIds.has(id)
      })
    }
  }

  for (const [paneKey, entry] of Object.entries(args.agentStatusByPaneKey)) {
    if (entry.state !== 'done' && entry.state !== 'blocked' && entry.state !== 'waiting') {
      continue
    }
    const separatorIndex = paneKey.indexOf(':')
    if (separatorIndex <= 0) {
      continue
    }
    const tabId = paneKey.slice(0, separatorIndex)
    const context = tabContext.get(tabId)
    if (!context) {
      continue
    }
    const ackAt = args.acknowledgedAgentsByPaneKey[paneKey] ?? 0
    events.push({
      id: `agent-live:${paneKey}:${entry.stateStartedAt}`,
      kind: 'agent',
      state: entry.state,
      timestamp: entry.stateStartedAt,
      worktree: context.worktree,
      repo: args.repoMap.get(context.worktree.repoId) ?? null,
      entry,
      tab: context.tab,
      agentType: entry.agentType ?? 'unknown',
      agentAlive: true,
      unread: ackAt < entry.stateStartedAt
    })
  }

  for (const [paneKey, retained] of Object.entries(args.retainedAgentsByPaneKey)) {
    const worktree = args.worktreeMap.get(retained.worktreeId)
    if (!worktree || retained.entry.state !== 'done') {
      continue
    }
    const ackAt = args.acknowledgedAgentsByPaneKey[paneKey] ?? 0
    events.push({
      id: `agent-retained:${paneKey}:${retained.entry.stateStartedAt}`,
      kind: 'agent',
      state: 'done',
      timestamp: retained.entry.stateStartedAt,
      worktree,
      repo: args.repoMap.get(worktree.repoId) ?? null,
      entry: retained.entry,
      tab: retained.tab,
      agentType: retained.agentType,
      agentAlive: false,
      unread: ackAt < retained.entry.stateStartedAt
    })
  }

  return events.sort((a, b) => b.timestamp - a.timestamp).slice(0, 80)
}

function buildWorktreeThreads(events: ActivityEvent[]): WorktreeThread[] {
  const byWorktreeId = new Map<string, WorktreeThread>()
  for (const event of events) {
    const existing = byWorktreeId.get(event.worktree.id)
    if (!existing) {
      byWorktreeId.set(event.worktree.id, {
        worktree: event.worktree,
        repo: event.repo,
        latestEvent: event,
        events: [event],
        unread: event.unread
      })
      continue
    }
    existing.events.push(event)
    existing.unread = existing.unread || event.unread
    if (event.timestamp > existing.latestEvent.timestamp) {
      existing.latestEvent = event
    }
  }

  return Array.from(byWorktreeId.values())
    .map((thread) => ({
      ...thread,
      events: [...thread.events].sort((a, b) => a.timestamp - b.timestamp)
    }))
    .sort((a, b) => b.latestEvent.timestamp - a.latestEvent.timestamp)
}

function EventTime({ timestamp }: { timestamp: number }): React.JSX.Element {
  const absolute = formatAbsoluteDate(timestamp)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="rounded px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={absolute}
          onClick={(event) => event.stopPropagation()}
        >
          {formatRelativeTime(timestamp)}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={6}>
        {absolute}
      </TooltipContent>
    </Tooltip>
  )
}

function EventRepoBadge({ repo }: { repo: Repo | null }): React.JSX.Element | null {
  if (!repo) {
    return null
  }
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-[4px] border border-border bg-accent px-1.5 py-0.5 dark:border-border/60 dark:bg-accent/50">
      <div className="size-1.5 rounded-full" style={{ backgroundColor: repo.badgeColor }} />
      <span className="max-w-[6rem] truncate text-[10px] font-semibold leading-none text-foreground lowercase">
        {repo.displayName}
      </span>
    </div>
  )
}

function AgentEventRow({
  event,
  density,
  onMarkRead
}: {
  event: AgentActivityEvent
  density: ActivityDensity
  onMarkRead: (event: ActivityEvent) => void
}): React.JSX.Element {
  const compact = density === 'compact'
  const dotState = asDotState(event.state)

  const jumpToAgent = (clickEvent: React.MouseEvent): void => {
    clickEvent.stopPropagation()
    onMarkRead(event)
    activateAndRevealWorktree(event.worktree.id)
    activateTabAndFocusPane(event.tab.id, paneIdFromPaneKey(event.entry.paneKey))
  }

  return (
    <div
      className={cn(
        'group grid grid-cols-[2rem_minmax(0,1fr)_7.25rem] gap-3 border-b border-border px-3 transition-colors hover:bg-accent/40',
        compact ? 'py-2' : 'py-3.5',
        event.unread && 'bg-accent/20'
      )}
      onClick={() => onMarkRead(event)}
    >
      <div className="flex justify-center pt-1">
        <div className="relative flex size-6 items-center justify-center">
          {event.unread ? (
            <span className="absolute -left-1 top-1 size-2 rounded-full bg-primary" />
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <AgentStateDot state={dotState} size="md" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {event.entry.interrupted ? 'Interrupted' : agentStateLabel(dotState)}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate text-sm', event.unread ? 'font-semibold' : 'font-medium')}>
            {agentTitle(event)}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <AgentIcon agent={agentTypeToIconAgent(event.agentType)} size={14} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {formatAgentTypeLabel(event.agentType)}
            </TooltipContent>
          </Tooltip>
        </div>
        <div
          className={cn(
            'mt-0.5 truncate text-sm text-muted-foreground',
            compact ? 'max-w-[760px]' : 'max-w-[920px]'
          )}
        >
          {agentSummary(event)}
        </div>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{event.worktree.displayName}</span>
          </span>
          <span>{agentMeta(event)}</span>
        </div>
        {!compact && event.agentAlive ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button type="button" variant="outline" size="xs" onClick={jumpToAgent}>
              Jump to agent
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col items-end gap-2 pt-0.5">
        <EventTime timestamp={event.timestamp} />
        {compact && event.agentAlive ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={jumpToAgent}
            className="opacity-0 transition-opacity group-hover:opacity-100"
          >
            Agent
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function WorktreeEventRow({
  event,
  density,
  onMarkRead
}: {
  event: WorktreeActivityEvent
  density: ActivityDensity
  onMarkRead: (event: ActivityEvent) => void
}): React.JSX.Element {
  const compact = density === 'compact'

  return (
    <div
      className={cn(
        'group grid grid-cols-[2rem_minmax(0,1fr)_7.25rem] gap-3 border-b border-border px-3 transition-colors hover:bg-accent/40',
        compact ? 'py-2' : 'py-3.5',
        event.unread && 'bg-accent/20'
      )}
      onClick={() => onMarkRead(event)}
    >
      <div className="flex justify-center pt-0.5">
        <div className="relative flex size-6 items-center justify-center text-muted-foreground">
          {event.unread ? (
            <span className="absolute -left-1 top-1 size-2 rounded-full bg-primary" />
          ) : null}
          <Plus className="size-4" />
        </div>
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate text-sm', event.unread ? 'font-semibold' : 'font-medium')}>
            Worktree created
          </span>
        </div>
        <div className="mt-0.5 truncate text-sm text-muted-foreground">
          {event.worktree.displayName}
        </div>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{event.worktree.branch}</span>
          </span>
          <span>{event.worktree.path}</span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-2 pt-0.5">
        <EventTime timestamp={event.timestamp} />
      </div>
    </div>
  )
}

function ActivityRow({
  event,
  density,
  onMarkRead
}: {
  event: ActivityEvent
  density: ActivityDensity
  onMarkRead: (event: ActivityEvent) => void
}): React.JSX.Element {
  return event.kind === 'agent' ? (
    <AgentEventRow event={event} density={density} onMarkRead={onMarkRead} />
  ) : (
    <WorktreeEventRow event={event} density={density} onMarkRead={onMarkRead} />
  )
}

function groupForTimestamp(timestamp: number): 'Today' | 'Yesterday' | 'Earlier' {
  const date = new Date(timestamp)
  const today = new Date()
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startYesterday = startToday - 24 * 60 * 60 * 1000
  if (date.getTime() >= startToday) {
    return 'Today'
  }
  if (date.getTime() >= startYesterday) {
    return 'Yesterday'
  }
  return 'Earlier'
}

function ThreadRow({
  thread,
  density,
  selected,
  onSelect,
  onToggleRead
}: {
  thread: WorktreeThread
  density: ActivityDensity
  selected: boolean
  onSelect: () => void
  onToggleRead: () => void
}): React.JSX.Element {
  const latest = thread.latestEvent
  const compact = density === 'compact'
  const toggleLabel = thread.unread ? 'Mark thread read' : 'Mark thread unread'
  return (
    <div
      data-current={selected ? 'true' : undefined}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'group relative grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-border px-3 text-left transition-colors hover:bg-accent/40',
        compact ? 'py-1.5' : 'py-2.5',
        selected &&
          'bg-black/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:bg-white/[0.10] dark:shadow-[0_1px_2px_rgba(0,0,0,0.03)]',
        thread.unread && 'bg-primary/[0.045] dark:bg-primary/[0.08]'
      )}
    >
      {thread.unread ? (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-primary" />
      ) : null}
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'truncate text-sm',
              thread.unread ? 'font-semibold text-foreground' : 'font-medium text-foreground'
            )}
          >
            {thread.worktree.displayName}
          </span>
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5">
          <EventRepoBadge repo={thread.repo} />
          <span className="truncate text-xs text-muted-foreground">{eventTitle(latest)}</span>
        </span>
        {!compact ? (
          <span className="mt-1 block truncate text-xs text-muted-foreground">
            {eventSummary(latest)}
          </span>
        ) : null}
      </span>
      <span className={cn('flex flex-col items-end pt-0.5', compact ? 'gap-1' : 'gap-2')}>
        <span className="flex min-w-16 flex-col items-end gap-1">
          <span className="relative flex h-6 min-w-16 items-start justify-end">
            <span className="transition-opacity group-hover:opacity-0">
              <EventTime timestamp={latest.timestamp} />
            </span>
            <span className="absolute right-0 top-0 opacity-0 transition-opacity group-hover:opacity-100">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-xs"
                    aria-label={toggleLabel}
                    onClick={(event) => {
                      event.stopPropagation()
                      onToggleRead()
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    {thread.unread ? <BellOff className="size-3" /> : <Bell className="size-3" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">{toggleLabel}</TooltipContent>
              </Tooltip>
            </span>
          </span>
          <span className="inline-flex items-center gap-1">
            {thread.unread ? (
              <span className="rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-semibold leading-none text-primary-foreground">
                New
              </span>
            ) : null}
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
              {thread.events.length}
            </Badge>
          </span>
        </span>
      </span>
    </div>
  )
}

export default function ActivityPrototypePage(): React.JSX.Element {
  const [readFilter, setReadFilter] = useState<ThreadReadFilter>('all')
  const [leftSidebarCompact, setLeftSidebarCompact] = useState(true)
  const leftSidebarDensity: ActivityDensity = leftSidebarCompact ? 'compact' : 'comfortable'
  const [query, setQuery] = useState('')
  const [locallyReadEventIds, setLocallyReadEventIds] = useState<Set<string>>(() => new Set())
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null)
  const [threadListWidth, setThreadListWidth] = useState(340)
  const {
    containerRef: threadListRef,
    isResizing: isThreadListResizing,
    onResizeStart
  } = useSidebarResize<HTMLDivElement>({
    isOpen: true,
    width: threadListWidth,
    minWidth: 280,
    maxWidth: 560,
    deltaSign: 1,
    setWidth: setThreadListWidth
  })

  const storeData = useAppStore(
    useShallow((s) => ({
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
      tabsByWorktree: s.tabsByWorktree,
      worktreeMap: getWorktreeMapFromState(s),
      repoMap: getRepoMapFromState(s),
      acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey,
      acknowledgeAgents: s.acknowledgeAgents,
      unacknowledgeAgents: s.unacknowledgeAgents,
      markWorktreeUnread: s.markWorktreeUnread,
      clearWorktreeUnread: s.clearWorktreeUnread
    }))
  )

  const allEvents = useMemo(
    () =>
      buildActivityEvents({
        ...storeData,
        locallyReadEventIds
      }),
    [storeData, locallyReadEventIds]
  )

  const allThreads = useMemo(() => buildWorktreeThreads(allEvents), [allEvents])

  const visibleThreads = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase()
    return allThreads.filter((thread) => {
      if (readFilter === 'unread' && !thread.unread) {
        return false
      }
      if (!trimmedQuery) {
        return true
      }
      const latest = thread.latestEvent
      const text =
        `${thread.worktree.displayName} ${thread.repo?.displayName ?? ''} ${eventTitle(latest)} ${eventSummary(latest)} ${eventMeta(latest)}`.toLowerCase()
      return text.includes(trimmedQuery)
    })
  }, [allThreads, readFilter, query])

  useEffect(() => {
    if (visibleThreads.length === 0) {
      setSelectedWorktreeId(null)
      return
    }
    if (
      !selectedWorktreeId ||
      !visibleThreads.some((thread) => thread.worktree.id === selectedWorktreeId)
    ) {
      setSelectedWorktreeId(visibleThreads[0].worktree.id)
    }
  }, [selectedWorktreeId, visibleThreads])

  const selectedThread =
    visibleThreads.find((thread) => thread.worktree.id === selectedWorktreeId) ??
    visibleThreads[0] ??
    null

  const selectedGroupedEvents = useMemo(() => {
    const groups: Record<'Today' | 'Yesterday' | 'Earlier', ActivityEvent[]> = {
      Today: [],
      Yesterday: [],
      Earlier: []
    }
    if (!selectedThread) {
      return groups
    }
    for (const event of selectedThread.events) {
      groups[groupForTimestamp(event.timestamp)].push(event)
    }
    return groups
  }, [selectedThread])

  const selectThread = (thread: WorktreeThread): void => {
    setSelectedWorktreeId(thread.worktree.id)
    markThreadRead(thread)
  }

  const markThreadRead = (thread: WorktreeThread): void => {
    const agentPaneKeys = thread.events.flatMap((event) =>
      event.kind === 'agent' ? [event.entry.paneKey] : []
    )
    storeData.acknowledgeAgents(agentPaneKeys)
    if (thread.events.some((event) => event.kind === 'worktree-created')) {
      storeData.clearWorktreeUnread(thread.worktree.id)
    }
    setLocallyReadEventIds((current) => {
      const next = new Set(current)
      for (const event of thread.events) {
        next.add(event.id)
      }
      return next
    })
  }

  const markThreadUnread = (thread: WorktreeThread): void => {
    const agentPaneKeys = thread.events.flatMap((event) =>
      event.kind === 'agent' ? [event.entry.paneKey] : []
    )
    storeData.unacknowledgeAgents(agentPaneKeys)
    if (thread.events.some((event) => event.kind === 'worktree-created')) {
      storeData.markWorktreeUnread(thread.worktree.id)
    }
    setLocallyReadEventIds((current) => {
      const next = new Set(current)
      for (const event of thread.events) {
        next.delete(event.id)
      }
      return next
    })
  }

  const toggleThreadRead = (thread: WorktreeThread): void => {
    if (thread.unread) {
      markThreadRead(thread)
      return
    }
    markThreadUnread(thread)
  }

  const markRead = (event: ActivityEvent): void => {
    if (event.kind === 'agent') {
      storeData.acknowledgeAgents([event.entry.paneKey])
      return
    }
    setLocallyReadEventIds((current) => new Set(current).add(event.id))
    storeData.clearWorktreeUnread(event.worktree.id)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background px-4 py-3">
      <main className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          ref={threadListRef}
          className="relative flex min-h-0 shrink-0 flex-col border-r border-border"
          style={{ width: threadListWidth }}
        >
          <div className="shrink-0 border-b border-border px-2 py-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                Worktrees
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Activity list display options"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Settings className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="bottom" className="min-w-44">
                  <DropdownMenuLabel>Display style</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem
                    checked={leftSidebarCompact}
                    onCheckedChange={(checked) => setLeftSidebarCompact(checked === true)}
                  >
                    Compact list
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter..."
                  className="h-8 w-full pl-7 text-xs"
                />
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Toggle
                    pressed={readFilter === 'unread'}
                    onPressedChange={(pressed) => setReadFilter(pressed ? 'unread' : 'all')}
                    variant="outline"
                    size="sm"
                    className={cn(
                      'size-8 shrink-0 p-0',
                      readFilter === 'unread'
                        ? '!border-primary !bg-primary !text-primary-foreground shadow-xs ring-2 ring-primary/35 hover:!bg-primary/90 hover:!text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    aria-label="Show unread threads only"
                  >
                    <BellDot className="size-3.5" />
                  </Toggle>
                </TooltipTrigger>
                <TooltipContent side="bottom">Show unread threads only</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
            {visibleThreads.map((thread) => (
              <ThreadRow
                key={thread.worktree.id}
                thread={thread}
                density={leftSidebarDensity}
                selected={thread.worktree.id === selectedThread?.worktree.id}
                onSelect={() => selectThread(thread)}
                onToggleRead={() => toggleThreadRead(thread)}
              />
            ))}
            {visibleThreads.length === 0 ? (
              <div className="px-3 py-8 text-sm text-muted-foreground">
                No worktree threads match these filters.
              </div>
            ) : null}
          </div>
          <div
            aria-label="Resize activity thread list"
            title="Drag to resize"
            className={cn(
              'group absolute -right-1.5 top-0 z-20 flex h-full w-3 cursor-col-resize items-stretch justify-center',
              isThreadListResizing && 'bg-ring/10'
            )}
            onMouseDown={onResizeStart}
            role="separator"
          >
            <div
              className={cn(
                'h-full w-px bg-border transition-colors group-hover:bg-ring/50',
                isThreadListResizing && 'bg-ring'
              )}
            />
          </div>
        </aside>

        <section className="min-w-0 flex-1 overflow-hidden pt-2">
          {selectedThread ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-4 pb-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <h2 className="truncate text-base font-semibold">
                      {selectedThread.worktree.displayName}
                    </h2>
                    <EventRepoBadge repo={selectedThread.repo} />
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    Complete worktree history, from creation through latest agent updates
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    markThreadRead(selectedThread)
                    activateAndRevealWorktree(selectedThread.worktree.id)
                  }}
                >
                  Jump to worktree
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
                {(['Today', 'Yesterday', 'Earlier'] as const).map((group) =>
                  selectedGroupedEvents[group].length > 0 ? (
                    <section key={group}>
                      <div className="border-b border-border px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                        {group}
                      </div>
                      {[...selectedGroupedEvents[group]].reverse().map((event) => (
                        <ActivityRow
                          key={event.id}
                          event={event}
                          density="comfortable"
                          onMarkRead={markRead}
                        />
                      ))}
                    </section>
                  ) : null
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <MessageSquareText className="size-7" />
              No activity yet.
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
