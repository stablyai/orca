/* eslint-disable max-lines -- Why: this prototype keeps the real-data adapter
and current visual skeleton together until the next refinement pass decides
which pieces become production modules. */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Bell,
  BellDot,
  ExternalLink,
  ListTree,
  MessageSquareText,
  MoreVertical,
  Search,
  TerminalSquare
} from 'lucide-react'

import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
import { AgentIcon } from '@/lib/agent-catalog'
import {
  agentTypeToIconAgent,
  formatAgentTypeLabel,
  isExplicitAgentStatusFresh
} from '@/lib/agent-status'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { FilledBellIcon } from '../sidebar/WorktreeCardHelpers'
import CommentMarkdown from '../sidebar/CommentMarkdown'
import {
  setActivityTerminalPortals,
  type ActivityTerminalPortalTarget
} from './activity-terminal-portal'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStateHistoryEntry,
  type AgentStatusEntry,
  type AgentStatusState,
  type AgentType
} from '../../../../shared/agent-status-types'

type ThreadReadFilter = 'all' | 'unread'
type ActivityGroupMode = 'recent' | 'status'
type ActivityEventState = Extract<AgentStatusState, 'done' | 'blocked' | 'waiting'>
type ActivityLiveAgentState = Extract<AgentStatusState, 'working' | 'blocked' | 'waiting'>
type ActivityStatusGroupId = 'working' | 'blocked' | 'waiting' | 'done' | 'interrupted'

type ActivityEvent = {
  id: string
  state: ActivityEventState
  timestamp: number
  worktree: Worktree
  repo: Repo | null
  entry: AgentStatusEntry
  tab: TerminalTab
  agentType: AgentType
  agentAlive: boolean
  unread: boolean
}

type ActivityLiveAgentSnapshot = {
  state: ActivityLiveAgentState
  timestamp: number
  worktree: Worktree
  repo: Repo | null
  entry: AgentStatusEntry
  tab: TerminalTab
  agentType: AgentType
}

// Why (per-pane thread): the activity feed is keyed on the agent pane (a
// terminal tab + pane id) rather than on the workspace, so the left list
// shows one entry per agent. paneKey is the stable identity (`${tabId}:${paneId}`).
type AgentPaneThread = {
  paneKey: string
  paneTitle: string
  worktree: Worktree
  repo: Repo | null
  tab: TerminalTab
  agentType: AgentType
  currentAgentState: ActivityLiveAgentState | null
  currentAgentEntry: AgentStatusEntry | null
  responsePreview: string
  latestTimestamp: number
  latestEvent: ActivityEvent | null
  events: ActivityEvent[]
  unread: boolean
}

type ActivityThreadGroup = {
  id: ActivityStatusGroupId
  label: string
  state: AgentStatusState
  threads: AgentPaneThread[]
}

type ActivityTerminalPortalReadiness = {
  target: HTMLElement | null
  tabId: string | null
  ready: boolean
}

type ActivityTerminalPortalDomStatus = {
  hasSelectedRoot: boolean
  ready: boolean
}

type ActivityTerminalPortalSlotId = 'primary' | 'secondary'

const ACTIVITY_TERMINAL_LOADING_LABEL_DELAY_MS = 180
const ACTIVITY_THREAD_RESPONSE_RENDER_PREVIEW_MAX_LENGTH = 320
const ACTIVITY_STATUS_GROUP_ORDER: ActivityStatusGroupId[] = [
  'working',
  'blocked',
  'waiting',
  'done',
  'interrupted'
]

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

function truncatePreservingSurrogates(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  const truncated = value.slice(0, maxLength)
  const lastCode = truncated.charCodeAt(truncated.length - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    return truncated.slice(0, -1)
  }
  return truncated
}

export function activityThreadResponseRenderPreview({
  responsePreview
}: {
  responsePreview: string
}): string {
  const trimmed = responsePreview.trim()
  if (trimmed.length <= ACTIVITY_THREAD_RESPONSE_RENDER_PREVIEW_MAX_LENGTH) {
    return trimmed
  }
  return `${truncatePreservingSurrogates(
    trimmed,
    ACTIVITY_THREAD_RESPONSE_RENDER_PREVIEW_MAX_LENGTH
  ).trimEnd()}...`
}

function paneIdFromPaneKey(paneKey: string): number | null {
  const colon = paneKey.indexOf(':')
  const tail = colon > 0 ? paneKey.slice(colon + 1) : ''
  const parsed = /^\d+$/.test(tail) ? Number.parseInt(tail, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function getSelectedActivityTerminalPortalStatus(
  target: HTMLElement,
  tabId: string
): ActivityTerminalPortalDomStatus {
  let selectedRoot: HTMLElement | null = null
  for (const candidate of target.querySelectorAll<HTMLElement>('[data-terminal-tab-id]')) {
    if (candidate.dataset.terminalTabId === tabId) {
      selectedRoot = candidate
      break
    }
  }
  if (!selectedRoot) {
    return { hasSelectedRoot: false, ready: false }
  }
  const hasPtyBinding =
    selectedRoot.hasAttribute('data-pty-id') ||
    selectedRoot.querySelector<HTMLElement>('[data-pty-id]') !== null
  const hasXtermScreen = selectedRoot.querySelector<HTMLElement>('.xterm-screen') !== null
  return { hasSelectedRoot: true, ready: hasPtyBinding && hasXtermScreen }
}

function useActivityTerminalPortalReadiness(
  target: HTMLElement | null,
  tabId: string | null
): boolean {
  const [readiness, setReadiness] = useState<ActivityTerminalPortalReadiness>({
    target: null,
    tabId: null,
    ready: false
  })

  useLayoutEffect(() => {
    if (!target || !tabId) {
      setReadiness((prev) =>
        prev.target === null && prev.tabId === null && !prev.ready
          ? prev
          : { target: null, tabId: null, ready: false }
      )
      return
    }

    let disposed = false
    let readyFrame: number | null = null
    let sawUnreadySelectedRoot = false

    const updateReadiness = (ready: boolean): void => {
      setReadiness((prev) =>
        prev.target === target && prev.tabId === tabId && prev.ready === ready
          ? prev
          : { target, tabId, ready }
      )
    }

    const cancelReadyFrame = (): void => {
      if (readyFrame !== null) {
        cancelAnimationFrame(readyFrame)
        readyFrame = null
      }
    }

    const checkReadiness = (): void => {
      const status = getSelectedActivityTerminalPortalStatus(target, tabId)
      if (status.ready) {
        if (!sawUnreadySelectedRoot) {
          cancelReadyFrame()
          updateReadiness(true)
          return
        }
        if (readyFrame !== null) {
          return
        }
        // Why: the PTY id can appear before xterm has painted replayed output.
        // Waiting one frame keeps Activity's cover in place for the blank canvas
        // frame without moving terminal lifecycle work into global layout effects.
        readyFrame = requestAnimationFrame(() => {
          readyFrame = null
          if (!disposed && getSelectedActivityTerminalPortalStatus(target, tabId).ready) {
            updateReadiness(true)
          }
        })
        return
      }
      if (status.hasSelectedRoot) {
        sawUnreadySelectedRoot = true
      }
      cancelReadyFrame()
      updateReadiness(false)
    }

    updateReadiness(false)
    checkReadiness()

    const observer = new MutationObserver(checkReadiness)
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-terminal-tab-id', 'data-pty-id']
    })

    return () => {
      disposed = true
      cancelReadyFrame()
      observer.disconnect()
    }
  }, [target, tabId])

  return readiness.target === target && readiness.tabId === tabId && readiness.ready
}

function otherActivityTerminalSlot(
  slotId: ActivityTerminalPortalSlotId
): ActivityTerminalPortalSlotId {
  return slotId === 'primary' ? 'secondary' : 'primary'
}

function useActivityTerminalLoadingLabel(loading: boolean): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!loading) {
      setVisible(false)
      return
    }
    const timer = setTimeout(() => setVisible(true), ACTIVITY_TERMINAL_LOADING_LABEL_DELAY_MS)
    return () => clearTimeout(timer)
  }, [loading])

  return visible
}

function agentTitle(event: ActivityEvent): string {
  if (event.state === 'done') {
    return event.entry.interrupted ? 'Agent interrupted' : 'Agent finished'
  }
  return event.state === 'waiting' ? 'Agent waiting for input' : 'Agent needs input'
}

function agentSummary(event: ActivityEvent): string {
  const prompt = event.entry.prompt.trim()
  if (event.state === 'done') {
    const message = event.entry.lastAssistantMessage?.trim()
    return message || prompt || 'Completed the current turn.'
  }
  return prompt || event.entry.lastAssistantMessage?.trim() || 'The agent paused for user input.'
}

function agentMeta(event: ActivityEvent): string {
  const agent = formatAgentTypeLabel(event.agentType)
  if (event.state === 'done') {
    return event.entry.interrupted ? `${agent} interrupted` : `${agent} completed`
  }
  return event.state === 'waiting' ? `${agent} waiting` : `${agent} blocked`
}

// Why (label hierarchy): mirror DashboardAgentRow — the agent's last prompt
// IS what the agent is working on and is the primary signal users want at a
// glance. A user-renamed customTitle still wins (explicit rename intent), but
// the OSC-set live title ("Claude Code", "Codex", …) must NOT shadow the
// prompt: agent CLIs set that title eagerly, so preferring it would pin every
// row to the agent name and hide the actual turn. Fall back to a non-default
// liveTitle only when there is no prompt at all.
function paneTitleForEntry(entry: AgentStatusEntry, tab: TerminalTab): string {
  const customTitle = tab.customTitle?.trim()
  if (customTitle) {
    return customTitle
  }
  const prompt = entry.prompt.trim()
  if (prompt) {
    return prompt
  }
  const liveTitle = tab.title?.trim()
  const defaultTitle = tab.defaultTitle?.trim()
  if (liveTitle && liveTitle !== defaultTitle) {
    return liveTitle
  }
  return defaultTitle || liveTitle || 'Terminal'
}

function paneTitleForEvent(event: ActivityEvent): string {
  return paneTitleForEntry(event.entry, event.tab)
}

function responsePreviewForEntry(entry: AgentStatusEntry): string {
  return entry.lastAssistantMessage?.trim() ?? ''
}

function isActivityEventState(state: AgentStatusState): state is ActivityEventState {
  return state === 'done' || state === 'blocked' || state === 'waiting'
}

function isActivityLiveAgentState(state: AgentStatusState): state is ActivityLiveAgentState {
  return state === 'working' || state === 'blocked' || state === 'waiting'
}

function freshActivityLiveAgentState(
  entry: AgentStatusEntry,
  now: number
): ActivityLiveAgentState | null {
  if (!isActivityLiveAgentState(entry.state)) {
    return null
  }
  return isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS) ? entry.state : null
}

// Why: per-pane cap guarantees each agent appears in the left list even when one pane has a long history.
const EVENTS_PER_PANE_CAP = 5

function historyEntrySnapshot(
  entry: AgentStatusEntry,
  history: AgentStateHistoryEntry
): AgentStatusEntry {
  return {
    ...entry,
    state: history.state,
    prompt: history.prompt,
    updatedAt: history.startedAt,
    stateStartedAt: history.startedAt,
    stateHistory: [],
    toolName: undefined,
    toolInput: undefined,
    lastAssistantMessage: undefined,
    interrupted: history.interrupted
  }
}

function appendActivityEvent(args: {
  events: ActivityEvent[]
  seenEventIds: Set<string>
  state: ActivityEventState
  timestamp: number
  worktree: Worktree
  repo: Repo | null
  entry: AgentStatusEntry
  tab: TerminalTab
  agentType: AgentType
  agentAlive: boolean
  acknowledgedAt: number
}): void {
  const id = `agent:${args.entry.paneKey}:${args.state}:${args.timestamp}`
  if (args.seenEventIds.has(id)) {
    return
  }
  args.seenEventIds.add(id)
  args.events.push({
    id,
    state: args.state,
    timestamp: args.timestamp,
    worktree: args.worktree,
    repo: args.repo,
    entry: args.entry,
    tab: args.tab,
    agentType: args.agentType,
    agentAlive: args.agentAlive,
    unread: args.acknowledgedAt < args.timestamp
  })
}

function appendActivityEventsForEntry(args: {
  events: ActivityEvent[]
  seenEventIds: Set<string>
  entry: AgentStatusEntry
  worktree: Worktree
  repo: Repo | null
  tab: TerminalTab
  agentType: AgentType
  agentAlive: boolean
  acknowledgedAt: number
}): void {
  // Why: Activity is an append-only history surface. When a user continues in
  // the same terminal pane, the live entry moves done→working; stateHistory is
  // the only place the previous done/blocking event still exists.
  for (const history of args.entry.stateHistory) {
    if (!isActivityEventState(history.state)) {
      continue
    }
    appendActivityEvent({
      ...args,
      state: history.state,
      timestamp: history.startedAt,
      entry: historyEntrySnapshot(args.entry, history)
    })
  }

  if (!isActivityEventState(args.entry.state)) {
    return
  }
  appendActivityEvent({
    ...args,
    state: args.entry.state,
    timestamp: args.entry.stateStartedAt
  })
}

export function buildActivityEvents(args: {
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  tabsByWorktree: Record<string, TerminalTab[]>
  worktreeMap: Map<string, Worktree>
  repoMap: Map<string, Repo>
  acknowledgedAgentsByPaneKey: Record<string, number>
  now: number
}): {
  events: ActivityEvent[]
  liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot>
} {
  const events: ActivityEvent[] = []
  const seenEventIds = new Set<string>()
  const tabContext = new Map<string, { worktree: Worktree; tab: TerminalTab }>()
  const liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot> = {}

  for (const worktree of args.worktreeMap.values()) {
    const tabs = args.tabsByWorktree[worktree.id] ?? []
    for (const tab of tabs) {
      tabContext.set(tab.id, { worktree, tab })
    }
  }

  for (const [paneKey, entry] of Object.entries(args.agentStatusByPaneKey)) {
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
    // Why: live status is separate from historical events. A fresh working turn
    // should update/create the pane thread without being counted as an unread
    // done/blocked/waiting event.
    const liveState = freshActivityLiveAgentState(entry, args.now)
    if (liveState) {
      liveAgentByPaneKey[paneKey] = {
        state: liveState,
        timestamp: entry.stateStartedAt,
        worktree: context.worktree,
        repo: args.repoMap.get(context.worktree.repoId) ?? null,
        entry,
        tab: context.tab,
        agentType: entry.agentType ?? 'unknown'
      }
    }
    appendActivityEventsForEntry({
      events,
      seenEventIds,
      worktree: context.worktree,
      repo: args.repoMap.get(context.worktree.repoId) ?? null,
      entry,
      tab: context.tab,
      agentType: entry.agentType ?? 'unknown',
      agentAlive: true,
      acknowledgedAt: ackAt
    })
  }

  for (const [paneKey, retained] of Object.entries(args.retainedAgentsByPaneKey)) {
    const worktree = args.worktreeMap.get(retained.worktreeId)
    if (!worktree) {
      continue
    }
    const ackAt = args.acknowledgedAgentsByPaneKey[paneKey] ?? 0
    appendActivityEventsForEntry({
      events,
      seenEventIds,
      worktree,
      repo: args.repoMap.get(worktree.repoId) ?? null,
      entry: retained.entry,
      tab: retained.tab,
      agentType: retained.agentType,
      agentAlive: false,
      acknowledgedAt: ackAt
    })
  }

  const sorted = events.sort((a, b) => b.timestamp - a.timestamp)
  const perPaneCount = new Map<string, number>()
  const capped: ActivityEvent[] = []
  for (const event of sorted) {
    const paneKey = event.entry.paneKey
    const count = perPaneCount.get(paneKey) ?? 0
    if (count >= EVENTS_PER_PANE_CAP) {
      continue
    }
    perPaneCount.set(paneKey, count + 1)
    capped.push(event)
    if (capped.length >= 80) {
      break
    }
  }
  return { events: capped, liveAgentByPaneKey }
}

export function buildAgentPaneThreads(args: {
  events: ActivityEvent[]
  liveAgentByPaneKey: Record<string, ActivityLiveAgentSnapshot>
}): AgentPaneThread[] {
  const byPaneKey = new Map<string, AgentPaneThread>()
  for (const event of args.events) {
    const paneKey = event.entry.paneKey
    const existing = byPaneKey.get(paneKey)
    if (!existing) {
      byPaneKey.set(paneKey, {
        paneKey,
        paneTitle: paneTitleForEvent(event),
        worktree: event.worktree,
        repo: event.repo,
        tab: event.tab,
        agentType: event.agentType,
        currentAgentState: null,
        currentAgentEntry: null,
        responsePreview: responsePreviewForEntry(event.entry),
        latestTimestamp: event.timestamp,
        latestEvent: event,
        events: [event],
        unread: event.unread
      })
      continue
    }
    existing.events.push(event)
    existing.unread = existing.unread || event.unread
    if (!existing.latestEvent || event.timestamp > existing.latestEvent.timestamp) {
      existing.latestEvent = event
      existing.paneTitle = paneTitleForEvent(event)
      existing.agentType = event.agentType
      existing.tab = event.tab
      existing.responsePreview = responsePreviewForEntry(event.entry)
      existing.latestTimestamp = event.timestamp
    }
  }

  for (const [paneKey, liveAgent] of Object.entries(args.liveAgentByPaneKey)) {
    const existing = byPaneKey.get(paneKey)
    if (!existing) {
      byPaneKey.set(paneKey, {
        paneKey,
        paneTitle: paneTitleForEntry(liveAgent.entry, liveAgent.tab),
        worktree: liveAgent.worktree,
        repo: liveAgent.repo,
        tab: liveAgent.tab,
        agentType: liveAgent.agentType,
        currentAgentState: liveAgent.state,
        currentAgentEntry: liveAgent.entry,
        responsePreview: responsePreviewForEntry(liveAgent.entry),
        latestTimestamp: liveAgent.timestamp,
        latestEvent: null,
        events: [],
        unread: false
      })
      continue
    }
    // Why: live metadata is the current thread identity. Historical events stay
    // in the event list, but the row title/time/target must follow the active
    // turn so a running agent never shows the previous prompt as primary.
    existing.paneTitle = paneTitleForEntry(liveAgent.entry, liveAgent.tab)
    existing.worktree = liveAgent.worktree
    existing.repo = liveAgent.repo
    existing.tab = liveAgent.tab
    existing.agentType = liveAgent.agentType
    existing.currentAgentState = liveAgent.state
    existing.currentAgentEntry = liveAgent.entry
    existing.responsePreview = responsePreviewForEntry(liveAgent.entry)
    existing.latestTimestamp = liveAgent.timestamp
  }

  return Array.from(byPaneKey.values())
    .map((thread) => ({
      ...thread,
      events: [...thread.events].sort((a, b) => b.timestamp - a.timestamp)
    }))
    .sort((a, b) => b.latestTimestamp - a.latestTimestamp)
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
      <TooltipContent side="right" sideOffset={6}>
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

function threadAgentState(thread: AgentPaneThread): AgentStatusState {
  return thread.currentAgentState ?? thread.latestEvent?.state ?? 'done'
}

function threadAgentStateLabel(thread: AgentPaneThread): string {
  const state = threadAgentState(thread)
  if (!thread.currentAgentState && state === 'done' && thread.latestEvent?.entry.interrupted) {
    return 'Interrupted'
  }
  return agentStateLabel(state)
}

function threadStatusGroupId(thread: AgentPaneThread): ActivityStatusGroupId {
  const state = threadAgentState(thread)
  if (!thread.currentAgentState && state === 'done' && thread.latestEvent?.entry.interrupted) {
    return 'interrupted'
  }
  return state === 'working' || state === 'blocked' || state === 'waiting' ? state : 'done'
}

function threadStatusGroupState(id: ActivityStatusGroupId): AgentStatusState {
  return id === 'interrupted' ? 'done' : id
}

function threadStatusGroupLabel(id: ActivityStatusGroupId): string {
  if (id === 'interrupted') {
    return 'Interrupted'
  }
  return agentStateLabel(threadStatusGroupState(id))
}

export function groupActivityThreadsByStatus(threads: AgentPaneThread[]): ActivityThreadGroup[] {
  const groups = new Map<ActivityStatusGroupId, AgentPaneThread[]>()
  for (const thread of threads) {
    const groupId = threadStatusGroupId(thread)
    groups.set(groupId, [...(groups.get(groupId) ?? []), thread])
  }
  return ACTIVITY_STATUS_GROUP_ORDER.flatMap((id) => {
    const groupThreads = groups.get(id) ?? []
    if (groupThreads.length === 0) {
      return []
    }
    return [
      {
        id,
        label: threadStatusGroupLabel(id),
        state: threadStatusGroupState(id),
        threads: groupThreads
      }
    ]
  })
}

function threadSearchText(thread: AgentPaneThread): string {
  const latest = thread.latestEvent
  const stateLabel = threadAgentStateLabel(thread)
  const currentPrompt = thread.currentAgentEntry?.prompt.trim() ?? ''
  const currentSummary = thread.currentAgentEntry?.lastAssistantMessage?.trim() ?? ''
  const latestEventText = latest
    ? `${agentTitle(latest)} ${agentSummary(latest)} ${agentMeta(latest)}`
    : ''
  return `${thread.paneTitle} ${thread.worktree.displayName} ${thread.repo?.displayName ?? ''} ${formatAgentTypeLabel(thread.agentType)} ${stateLabel} ${currentPrompt} ${currentSummary} ${thread.responsePreview} ${latestEventText}`.toLowerCase()
}

export function activityThreadMatchesSearchQuery({
  thread,
  searchQuery
}: {
  thread: AgentPaneThread
  searchQuery: string
}): boolean {
  const trimmedQuery = searchQuery.trim().toLowerCase()
  return !trimmedQuery || threadSearchText(thread).includes(trimmedQuery)
}

function ThreadAgentStateIndicator({ thread }: { thread: AgentPaneThread }): React.JSX.Element {
  const state = threadAgentState(thread)
  const label = threadAgentStateLabel(thread)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          <AgentStateDot state={state} size="md" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function ActivityStatusGroupHeader({ group }: { group: ActivityThreadGroup }): React.JSX.Element {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <span className="inline-flex size-4 shrink-0 items-center justify-center">
        <AgentStateDot state={group.state} size="sm" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {group.label}
      </span>
      <span className="rounded-full border border-border bg-accent px-1.5 py-0.5 text-[10px] font-semibold leading-none text-muted-foreground">
        {group.threads.length}
      </span>
    </div>
  )
}

function isEventFromNestedInteractiveElement(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  const interactiveTarget = target.closest(
    'a, button, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])'
  )
  return (
    interactiveTarget instanceof HTMLElement &&
    interactiveTarget !== currentTarget &&
    currentTarget.contains(interactiveTarget)
  )
}

function ThreadRow({
  thread,
  selected,
  onSelect,
  onJump,
  onMarkUnread,
  compactMode
}: {
  thread: AgentPaneThread
  selected: boolean
  onSelect: () => void
  onJump: () => void
  onMarkUnread: () => void
  compactMode: boolean
}): React.JSX.Element {
  const renderedResponsePreview = activityThreadResponseRenderPreview({
    responsePreview: thread.responsePreview
  })
  return (
    <div
      data-current={selected ? 'true' : undefined}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        // Why: response markdown can contain links; keyboard activation on a
        // nested link should follow the link instead of selecting the row.
        if (isEventFromNestedInteractiveElement(event.target, event.currentTarget)) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        // Why (selected/hover/unread cues match WorktreeCard):
        // - selected → solid black/white tint + faint shadow, no hover
        //   override (the active class wins so hover doesn't fight it).
        // - non-selected → only then does hover apply (bg-accent/40), so a
        //   selected row stays visually fixed when the cursor moves over it.
        // - unread → weight + left-edge primary bar carry the cue; no row
        //   tint, mirroring WorktreeCard's "weight alone" pattern. Three
        //   stacked tints (selected + unread + hover) made selected and
        //   unread look identical when hovered.
        // Why (asymmetric padding): the title uses leading-snug, which adds
        // ~3px of internal space above the cap-height that isn't present
        // below the secondary badge row. Symmetric py made the top read
        // heavier; the smaller top pad visually evens the row.
        'group relative flex w-full cursor-pointer flex-col gap-1 border-b border-border px-3 pt-2.5 pb-3 text-left transition-colors',
        selected
          ? 'bg-black/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:bg-white/[0.10] dark:shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
          : 'hover:bg-accent/40'
      )}
    >
      {thread.unread ? (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-primary" />
      ) : null}
      {/* Why (right cluster aligned to title, not centered between rows):
          parking the timestamp on the title row leaves the secondary row
          full-width for the repo badge + branch name, which used to get
          truncated when the right cluster ate horizontal space. */}
      <div className="flex min-w-0 items-start gap-2">
        <span className="inline-flex shrink-0 items-start gap-1">
          <ThreadAgentStateIndicator thread={thread} />
          <span className="inline-flex shrink-0 pt-px">
            <AgentIcon agent={agentTypeToIconAgent(thread.agentType)} size={14} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <span
            className={cn(
              'min-w-0 text-xs leading-snug',
              compactMode ? 'block truncate' : 'line-clamp-3 break-words',
              thread.unread ? 'font-semibold text-foreground' : 'font-medium text-foreground'
            )}
            title={compactMode ? thread.paneTitle : undefined}
          >
            {thread.paneTitle}
          </span>
          {!compactMode && renderedResponsePreview ? (
            <CommentMarkdown
              content={renderedResponsePreview}
              className={cn(
                // Why: mirror the in-workspace agent card's compact response
                // preview while keeping Activity rows to one scannable line;
                // the content is capped before markdown parsing to keep large
                // assistant summaries cheap in long Activity lists.
                'mt-1 h-[1lh] min-w-0 overflow-hidden truncate whitespace-nowrap text-[11px] font-normal leading-snug text-muted-foreground/80',
                '[&_*]:inline [&_*]:!m-0 [&_*]:!p-0 [&_*]:!whitespace-nowrap [&_br]:hidden [&_ol]:list-none [&_ul]:list-none'
              )}
              title={thread.responsePreview}
            />
          ) : null}
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 pt-px">
          {/* Why (bell matches WorktreeCard pattern): unread → amber filled
              bell as a static, non-interactive cue (selecting the thread
              auto-marks it read, so a Mark-read button would be redundant);
              read → outline Bell that fades in on row hover and acts as
              Mark-unread. Bare button (no shadcn outline) so it reads as
              an inline cue rather than a discrete control square. */}
          <span className="inline-flex size-4 shrink-0 items-center justify-center">
            {thread.unread ? (
              <FilledBellIcon
                className="size-[13px] shrink-0 text-amber-500 drop-shadow-sm"
                aria-label="Unread"
              />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      onMarkUnread()
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    className={cn(
                      'group/unread flex size-4 shrink-0 cursor-pointer items-center justify-center rounded transition-all',
                      'hover:bg-accent/80 active:scale-95',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                    )}
                    aria-label="Mark thread unread"
                  >
                    <Bell className="size-3 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100 group-hover/unread:opacity-100" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">Mark thread unread</TooltipContent>
              </Tooltip>
            )}
          </span>
          <EventTime timestamp={thread.latestTimestamp} />
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-[42px]">
        <EventRepoBadge repo={thread.repo} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {thread.worktree.displayName}
        </span>
        {/* Why (Jump-to-workspace lives on the secondary row): the bell slot
            on the title row already holds the unread/Mark-unread state, so
            the navigation action gets its own slot down here aligned with
            the worktree name. Reserved layout via `invisible` +
            `pointer-events-none` keeps the worktree-name's flex-1 width
            stable across hover. */}
        <span
          className={cn(
            'ml-auto inline-flex shrink-0 items-center transition-opacity',
            'pointer-events-none invisible opacity-0',
            'group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100'
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                aria-label="Jump to workspace"
                onClick={(event) => {
                  event.stopPropagation()
                  onJump()
                }}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <ExternalLink className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Jump to workspace</TooltipContent>
          </Tooltip>
        </span>
      </div>
    </div>
  )
}

export default function ActivityPrototypePage(): React.JSX.Element {
  const [readFilter, setReadFilter] = useState<ThreadReadFilter>('all')
  const [groupMode, setGroupMode] = useState<ActivityGroupMode>('recent')
  const [query, setQuery] = useState('')
  const [compactMode, setCompactMode] = useState(false)
  const [selectedPaneKey, setSelectedPaneKey] = useState<string | null>(null)
  const [displayedPaneKey, setDisplayedPaneKey] = useState<string | null>(null)
  const [activePortalSlotId, setActivePortalSlotId] =
    useState<ActivityTerminalPortalSlotId>('primary')
  const [primaryPortalTargetEl, setPrimaryPortalTargetEl] = useState<HTMLElement | null>(null)
  const [secondaryPortalTargetEl, setSecondaryPortalTargetEl] = useState<HTMLElement | null>(null)
  // Why (default width): the thread cards are the primary surface in the
  // Activity view; the terminal is supplementary. A narrow list squeezed the
  // prompts to truncated single-liners and made the per-card actions feel
  // cramped. 480px gives prompts room to breathe at line-clamp-3 and leaves
  // the action buttons clearly readable.
  const [threadListWidth, setThreadListWidth] = useState(480)
  const {
    containerRef: threadListRef,
    isResizing: isThreadListResizing,
    onResizeStart
  } = useSidebarResize<HTMLDivElement>({
    isOpen: true,
    width: threadListWidth,
    minWidth: 320,
    maxWidth: 720,
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
      unacknowledgeAgents: s.unacknowledgeAgents
    }))
  )
  // Why: agentStatusEpoch is included in the dependency array (but not in the
  // computation itself) so the memo recomputes when freshness boundaries expire,
  // even if no new PTY data arrives.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)

  const { events: allEvents, liveAgentByPaneKey } = useMemo(
    () =>
      buildActivityEvents({
        agentStatusByPaneKey: storeData.agentStatusByPaneKey,
        retainedAgentsByPaneKey: storeData.retainedAgentsByPaneKey,
        tabsByWorktree: storeData.tabsByWorktree,
        worktreeMap: storeData.worktreeMap,
        repoMap: storeData.repoMap,
        acknowledgedAgentsByPaneKey: storeData.acknowledgedAgentsByPaneKey,
        // Why: Date.now() is read inside the memo (not as a dep) so stale-decay
        // recalculates whenever agentStatusEpoch ticks. The epoch bumps when the
        // freshness boundary crosses, driving re-evaluation without coupling to
        // wall-clock time directly.
        now: Date.now()
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeData, agentStatusEpoch]
  )

  const allThreads = useMemo(
    () => buildAgentPaneThreads({ events: allEvents, liveAgentByPaneKey }),
    [allEvents, liveAgentByPaneKey]
  )

  const visibleThreads = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase()
    return allThreads.filter((thread) => {
      // Why: keep the just-selected thread visible even after auto-mark-read
      // flips it to read, otherwise clicking a row in unread-only mode makes it
      // vanish from the left list while staying selected on the right.
      if (readFilter === 'unread' && !thread.unread && thread.paneKey !== selectedPaneKey) {
        return false
      }
      return activityThreadMatchesSearchQuery({ thread, searchQuery: trimmedQuery })
    })
  }, [allThreads, readFilter, query, selectedPaneKey])
  const visibleThreadGroups = useMemo(
    () => groupActivityThreadsByStatus(visibleThreads),
    [visibleThreads]
  )

  useEffect(() => {
    if (selectedPaneKey && !allThreads.some((thread) => thread.paneKey === selectedPaneKey)) {
      setSelectedPaneKey(null)
    }
  }, [allThreads, selectedPaneKey])

  const selectedThread = selectedPaneKey
    ? (allThreads.find((thread) => thread.paneKey === selectedPaneKey) ?? null)
    : null
  const selectedTabId = selectedThread?.tab.id ?? null
  const selectedHasLiveTab =
    selectedThread && selectedTabId
      ? (storeData.tabsByWorktree[selectedThread.worktree.id] ?? []).some(
          (tab) => tab.id === selectedTabId
        )
      : false
  const displayedThread = displayedPaneKey
    ? (allThreads.find((thread) => thread.paneKey === displayedPaneKey) ?? null)
    : null
  const displayedTabId = displayedThread?.tab.id ?? null
  const displayedHasLiveTab =
    displayedThread && displayedTabId
      ? (storeData.tabsByWorktree[displayedThread.worktree.id] ?? []).some(
          (tab) => tab.id === displayedTabId
        )
      : false
  const displayedIsSelectedTerminal =
    selectedThread &&
    displayedThread &&
    displayedThread.worktree.id === selectedThread.worktree.id &&
    displayedThread.tab.id === selectedThread.tab.id
  const visibleThread =
    selectedThread && selectedHasLiveTab
      ? displayedThread && displayedHasLiveTab && displayedThread.paneKey !== selectedThread.paneKey
        ? displayedIsSelectedTerminal
          ? selectedThread
          : displayedThread
        : selectedThread
      : null
  const stagedThread =
    selectedThread &&
    selectedHasLiveTab &&
    visibleThread &&
    visibleThread.paneKey !== selectedThread.paneKey &&
    !displayedIsSelectedTerminal
      ? selectedThread
      : null
  const inactivePortalSlotId = otherActivityTerminalSlot(activePortalSlotId)
  const portalTargetBySlot = {
    primary: primaryPortalTargetEl,
    secondary: secondaryPortalTargetEl
  } satisfies Record<ActivityTerminalPortalSlotId, HTMLElement | null>
  const activePortalTargetEl = portalTargetBySlot[activePortalSlotId]
  const inactivePortalTargetEl = portalTargetBySlot[inactivePortalSlotId]
  const visibleTabId = visibleThread?.tab.id ?? null
  const stagedTabId = stagedThread?.tab.id ?? null
  const visiblePortalReady = useActivityTerminalPortalReadiness(activePortalTargetEl, visibleTabId)
  const stagedPortalReady = useActivityTerminalPortalReadiness(inactivePortalTargetEl, stagedTabId)
  const showTerminalLoadingLabel = useActivityTerminalLoadingLabel(
    Boolean(visibleThread && !stagedThread && !visiblePortalReady)
  )

  const setPrimaryPortalTarget = useCallback((target: HTMLElement | null): void => {
    setPrimaryPortalTargetEl(target)
  }, [])

  const setSecondaryPortalTarget = useCallback((target: HTMLElement | null): void => {
    setSecondaryPortalTargetEl(target)
  }, [])

  // Why (no flash on selection): publish the portal descriptor with the
  // selected thread's worktreeId+tabId directly, instead of letting Terminal
  // derive it from activeWorktreeId/activeTabId. selectThread updates the
  // store in multiple steps (setActiveRepo → setActiveWorktree →
  // setActiveTabType → setActiveTab) and React commits in between can
  // briefly reflect the new worktree's stale "last active tab" — that's the
  // wrong-terminal flash. Anchoring the portal to the selected thread
  // sidesteps the race entirely.
  // Why useMemo: keep a stable descriptor identity across unrelated re-renders
  // so subscribers (Terminal → WorktreeSplitSurface) keep their React.memo
  // bail-outs. The inactive descriptor is a same-size staging slot: the old
  // terminal stays visible while the next terminal mounts underneath it.
  const portalDescriptors = useMemo(() => {
    const descriptors: ActivityTerminalPortalTarget[] = []
    if (visibleThread && activePortalTargetEl) {
      descriptors.push({
        slotId: activePortalSlotId,
        target: activePortalTargetEl,
        worktreeId: visibleThread.worktree.id,
        tabId: visibleThread.tab.id,
        paneId: paneIdFromPaneKey(visibleThread.paneKey),
        active: true
      })
    }
    if (stagedThread && inactivePortalTargetEl) {
      descriptors.push({
        slotId: inactivePortalSlotId,
        target: inactivePortalTargetEl,
        worktreeId: stagedThread.worktree.id,
        tabId: stagedThread.tab.id,
        paneId: paneIdFromPaneKey(stagedThread.paneKey),
        active: false
      })
    }
    return descriptors
  }, [
    activePortalSlotId,
    activePortalTargetEl,
    inactivePortalSlotId,
    inactivePortalTargetEl,
    stagedThread,
    visibleThread
  ])

  useLayoutEffect(() => {
    if (!selectedThread || !selectedHasLiveTab) {
      setDisplayedPaneKey(null)
      return
    }
    if (stagedThread && stagedPortalReady) {
      setActivePortalSlotId(inactivePortalSlotId)
      setDisplayedPaneKey(stagedThread.paneKey)
      return
    }
    if (!stagedThread && visibleThread?.paneKey === selectedThread.paneKey && visiblePortalReady) {
      setDisplayedPaneKey(selectedThread.paneKey)
    }
  }, [
    inactivePortalSlotId,
    selectedHasLiveTab,
    selectedThread,
    stagedPortalReady,
    stagedThread,
    visiblePortalReady,
    visibleThread
  ])

  // Why useLayoutEffect (not useEffect): publish must happen before paint so
  // Terminal's portal subscriber rerenders in the same commit. With useEffect
  // the publish runs after paint, so the user briefly sees Terminal's stale
  // portal target on screen — the "wrong terminal flash" symptom.
  // Why no cleanup-to-null on every change: clearing on dependency change
  // forces the portal through a null state on every thread switch (cleanup →
  // effect within one commit) which can flash the workspace pane behind the
  // activity slot. We only null on unmount, via a separate effect below.
  useLayoutEffect(() => {
    setActivityTerminalPortals(portalDescriptors)
  }, [portalDescriptors])

  useLayoutEffect(() => {
    return () => {
      setActivityTerminalPortals([])
    }
  }, [])

  const markThreadRead = (thread: AgentPaneThread): void => {
    storeData.acknowledgeAgents([thread.paneKey])
  }

  const markThreadUnread = (thread: AgentPaneThread): void => {
    storeData.unacknowledgeAgents([thread.paneKey])
  }

  const activateThreadTerminal = (thread: AgentPaneThread): void => {
    const state = useAppStore.getState()
    // Why: retained-agent threads can outlive their tab. With no live tab, the
    // right pane shows the empty-state placeholder; reorienting the workspace
    // and dispatching focus to a dead tab id would just confuse the user.
    const liveTabs = state.tabsByWorktree[thread.worktree.id] ?? []
    const hasLiveTab = liveTabs.some((t) => t.id === thread.tab.id)
    if (!hasLiveTab) {
      return
    }
    if (state.activeRepoId !== thread.worktree.repoId) {
      state.setActiveRepo(thread.worktree.repoId)
    }
    if (state.activeWorktreeId !== thread.worktree.id) {
      state.setActiveWorktree(thread.worktree.id)
    }
    state.setActiveTabType('terminal')
    activateTabAndFocusPane(thread.tab.id, paneIdFromPaneKey(thread.paneKey))
  }

  const selectThread = (thread: AgentPaneThread): void => {
    setSelectedPaneKey(thread.paneKey)
    markThreadRead(thread)
    activateThreadTerminal(thread)
  }

  const jumpToWorkspace = (thread: AgentPaneThread): void => {
    markThreadRead(thread)
    activateAndRevealWorktree(thread.worktree.id)
  }

  const hasUnreadThreads = allThreads.some((thread) => thread.unread)

  const markAllThreadsRead = (): void => {
    const unreadKeys = allThreads.filter((t) => t.unread).map((t) => t.paneKey)
    if (unreadKeys.length === 0) {
      return
    }
    storeData.acknowledgeAgents(unreadKeys)
  }

  // Why (page padding): drop top + horizontal padding so the page extends to
  // the window's left and right edges (matching how sidebars abut the chrome
  // elsewhere). The titlebar (ActivityTitlebarControls) already provides the
  // breathing-room band above; the right pane's title row supplies its own
  // top padding (pt-2) so the heading isn't pinned to the titlebar.
  return (
    <div className="flex h-full min-h-0 flex-col bg-background pb-3">
      <main className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          ref={threadListRef}
          className="relative flex min-h-0 shrink-0 flex-col border-r border-border"
          style={{ width: threadListWidth }}
        >
          <div className="shrink-0 border-b border-border px-2 pt-2 pb-2">
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <Toggle
                    pressed={groupMode === 'status'}
                    onPressedChange={(pressed) => setGroupMode(pressed ? 'status' : 'recent')}
                    variant="outline"
                    size="sm"
                    className={cn(
                      'size-8 shrink-0 p-0',
                      groupMode === 'status'
                        ? '!border-primary !bg-primary !text-primary-foreground shadow-xs ring-2 ring-primary/35 hover:!bg-primary/90 hover:!text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    aria-label="Group activity by status"
                  >
                    <ListTree className="size-3.5" />
                  </Toggle>
                </TooltipTrigger>
                <TooltipContent side="bottom">Group by status</TooltipContent>
              </Tooltip>
              {/* Why (overflow menu): "Mark all read" is a low-frequency,
                  destructive-feeling action — parking it behind a `…` keeps
                  the toolbar focused on the high-frequency Filter + unread
                  toggle while still giving the action a stable home next to
                  the list it acts on (rather than the titlebar). */}
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="size-8 shrink-0 border-input bg-transparent p-0 text-muted-foreground shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-transparent dark:hover:bg-accent dark:hover:text-accent-foreground"
                        aria-label="Thread list options"
                      >
                        <MoreVertical className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">More options</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" sideOffset={6}>
                  <DropdownMenuCheckboxItem
                    checked={compactMode}
                    onCheckedChange={(checked) => setCompactMode(checked === true)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    Compact mode
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => markAllThreadsRead()}
                    disabled={!hasUnreadThreads}
                  >
                    Mark all read
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
            {groupMode === 'status'
              ? visibleThreadGroups.map((group) => (
                  <section key={group.id} aria-label={`${group.label} activity`}>
                    <ActivityStatusGroupHeader group={group} />
                    {group.threads.map((thread) => (
                      <ThreadRow
                        key={thread.paneKey}
                        thread={thread}
                        selected={thread.paneKey === selectedThread?.paneKey}
                        onSelect={() => selectThread(thread)}
                        onJump={() => jumpToWorkspace(thread)}
                        onMarkUnread={() => markThreadUnread(thread)}
                        compactMode={compactMode}
                      />
                    ))}
                  </section>
                ))
              : visibleThreads.map((thread) => (
                  <ThreadRow
                    key={thread.paneKey}
                    thread={thread}
                    selected={thread.paneKey === selectedThread?.paneKey}
                    onSelect={() => selectThread(thread)}
                    onJump={() => jumpToWorkspace(thread)}
                    onMarkUnread={() => markThreadUnread(thread)}
                    compactMode={compactMode}
                  />
                ))}
            {visibleThreads.length === 0 ? (
              <div className="px-3 py-8 text-sm text-muted-foreground">
                No agent activity matches these filters.
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

        <section className="min-w-0 flex-1 overflow-hidden">
          {selectedThread ? (
            <div className="flex h-full min-h-0 flex-col">
              {/* Why (no header action button): per-card hover actions on the
                  thread list (Mark unread, Open) are the primary controls now,
                  so the header keeps just the thread identity. */}
              <div className="flex shrink-0 items-start gap-4 border-b border-border px-4 pt-2 pb-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-start gap-2">
                    <span className="inline-flex shrink-0 items-start gap-1">
                      <ThreadAgentStateIndicator thread={selectedThread} />
                      <span className="inline-flex shrink-0 pt-[3px]">
                        <AgentIcon
                          agent={agentTypeToIconAgent(selectedThread.agentType)}
                          size={16}
                        />
                      </span>
                    </span>
                    <h2 className="line-clamp-3 break-words text-sm font-semibold leading-snug">
                      {selectedThread.paneTitle}
                    </h2>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-11">
                    <EventRepoBadge repo={selectedThread.repo} />
                    <span className="truncate text-xs text-muted-foreground">
                      {selectedThread.worktree.displayName}
                    </span>
                  </div>
                </div>
              </div>
              {/* Why: Terminal stays mounted in the hidden workspace tree while
                  Activity is open. This target lets that existing TerminalPane
                  move here instead of creating a second PTY/xterm owner. */}
              {(() => {
                // Why: retained threads can outlive their tab; portal needs a live TerminalPane to render into.
                if (!selectedHasLiveTab) {
                  return (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                      <TerminalSquare className="size-7" />
                      Agent terminal closed. Open a new terminal in this workspace to continue.
                    </div>
                  )
                }
                return (
                  <div className="relative min-h-0 flex-1 overflow-hidden bg-editor-surface">
                    <div
                      ref={setPrimaryPortalTarget}
                      className={cn(
                        'absolute inset-0 min-h-0 min-w-0',
                        activePortalSlotId === 'primary'
                          ? 'z-10 opacity-100'
                          : 'pointer-events-none z-0 opacity-0'
                      )}
                      aria-hidden={activePortalSlotId !== 'primary'}
                      data-activity-terminal-slot-id="primary"
                    />
                    <div
                      ref={setSecondaryPortalTarget}
                      className={cn(
                        'absolute inset-0 min-h-0 min-w-0',
                        activePortalSlotId === 'secondary'
                          ? 'z-10 opacity-100'
                          : 'pointer-events-none z-0 opacity-0'
                      )}
                      aria-hidden={activePortalSlotId !== 'secondary'}
                      data-activity-terminal-slot-id="secondary"
                    />
                    {visibleThread && !stagedThread && !visiblePortalReady ? (
                      <div
                        className="pointer-events-none absolute inset-0 z-20 bg-editor-surface"
                        aria-hidden="true"
                      >
                        {showTerminalLoadingLabel ? (
                          <div className="ml-3 mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-background/85 px-2 py-1 text-xs text-muted-foreground shadow-xs">
                            <span className="h-3 w-1.5 animate-pulse rounded-sm bg-muted-foreground/70" />
                            <span>Connecting terminal...</span>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )
              })()}
            </div>
          ) : (
            <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              {visibleThreads.length === 0 ? (
                <>
                  <MessageSquareText className="size-7" />
                  No activity yet.
                </>
              ) : (
                <>
                  <TerminalSquare className="size-7" />
                  Select an agent to view its activity
                </>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
