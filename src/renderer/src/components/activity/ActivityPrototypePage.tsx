/* eslint-disable max-lines -- Why: prototype keeps the real-data adapter and visual skeleton together until a refinement pass splits them into modules. */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Bell,
  BellDot,
  ExternalLink,
  MessageSquareText,
  MoreVertical,
  Search,
  TerminalSquare
} from 'lucide-react'

import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { Button } from '@/components/ui/button'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { FilledBellIcon } from '../sidebar/WorktreeCardHelpers'
import CommentMarkdown from '../sidebar/CommentMarkdown'
import {
  setActivityTerminalPortals,
  type ActivityTerminalPortalTarget
} from './activity-terminal-portal'
import {
  reconcileActivityPortalThreads,
  resolveActivityPortalSwap
} from './activity-portal-thread-reconciliation'
import {
  ACTIVITY_PORTAL_READINESS_BURST_WINDOW_MS,
  createActivityPortalReadinessLatch,
  type ActivityPortalReadinessLatch,
  type ActivityPortalReadinessStatus
} from './activity-portal-readiness-oscillation'
import type { Repo } from '../../../../shared/types'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { getActivityThreadWorkspaceTitle } from '@/lib/activity-thread-display'
import { getAgentRowPrimaryText } from '@/lib/agent-row-primary-text'
import type { ActivityEvent, AgentPaneThread } from './activity-events'
import { buildActivityEvents, buildAgentPaneThreads } from './agent-pane-threads'

type ThreadReadFilter = 'all' | 'unread'
type ActivityGroupBy = 'status' | 'project' | 'worktree' | 'agent'
type ActivityStatusGroupId = 'working' | 'blocked' | 'waiting' | 'done' | 'interrupted'

type ActivityThreadGroup = {
  key: string
  id?: ActivityStatusGroupId
  label: string
  state?: AgentStatusState
  threads: AgentPaneThread[]
}

type ActivityTerminalPortalReadiness = {
  target: HTMLElement | null
  paneKey: string | null
  status: ActivityPortalReadinessStatus
}

type ActivityTerminalPortalDomStatus = {
  ready: boolean
  unavailable: boolean
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
const ACTIVITY_READ_FILTER_STORAGE_KEY = 'orca.activity.read-filter'

function readStoredActivityReadFilter(): ThreadReadFilter {
  try {
    return window.localStorage.getItem(ACTIVITY_READ_FILTER_STORAGE_KEY) === 'unread'
      ? 'unread'
      : 'all'
  } catch {
    return 'all'
  }
}

const absoluteDateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

function formatAbsoluteDate(timestamp: number): string {
  return absoluteDateFormatter.format(new Date(timestamp))
}

function formatRelativeTime(timestamp: number): string {
  return formatUiRelativeTime(timestamp - Date.now())
}

function findActivityTerminalPane(
  root: HTMLElement,
  leafId: string
): { foundAnyPane: boolean; pane: HTMLElement | null } {
  let foundAnyPane = false
  for (const candidate of root.querySelectorAll<HTMLElement>('[data-leaf-id]')) {
    foundAnyPane = true
    if (candidate.dataset.leafId === leafId) {
      return { foundAnyPane, pane: candidate }
    }
  }
  return { foundAnyPane, pane: null }
}

function hasInlineDisplayNoneBetween(element: HTMLElement, root: HTMLElement): boolean {
  let current: HTMLElement | null = element
  while (current) {
    if (current.style.display === 'none') {
      return true
    }
    if (current === root) {
      return false
    }
    current = current.parentElement
  }
  return false
}

function hasUnhiddenSiblingPane(root: HTMLElement, selectedPane: HTMLElement): boolean {
  for (const candidate of root.querySelectorAll<HTMLElement>('[data-leaf-id]')) {
    if (candidate !== selectedPane && !hasInlineDisplayNoneBetween(candidate, root)) {
      return true
    }
  }
  return false
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

function getSelectedActivityTerminalPortalStatus(
  target: HTMLElement,
  paneKey: string
): ActivityTerminalPortalDomStatus {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return { ready: false, unavailable: true }
  }
  let selectedRoot: HTMLElement | null = null
  for (const candidate of target.querySelectorAll<HTMLElement>('[data-terminal-tab-id]')) {
    if (candidate.dataset.terminalTabId === parsed.tabId) {
      selectedRoot = candidate
      break
    }
  }
  if (!selectedRoot) {
    return { ready: false, unavailable: false }
  }

  const { foundAnyPane, pane: selectedPane } = findActivityTerminalPane(selectedRoot, parsed.leafId)
  if (!selectedPane) {
    return { ready: false, unavailable: foundAnyPane }
  }

  const unavailable = hasInlineDisplayNoneBetween(selectedPane, selectedRoot)
  const hasUnisolatedSibling = hasUnhiddenSiblingPane(selectedRoot, selectedPane)
  const isVisibleRoot =
    !unavailable && (selectedPane.offsetParent !== null || selectedPane.getClientRects().length > 0)
  const hasPtyBinding =
    selectedPane.hasAttribute('data-pty-id') ||
    selectedPane.querySelector<HTMLElement>('[data-pty-id]') !== null
  const hasXtermScreen = selectedPane.querySelector<HTMLElement>('.xterm-screen') !== null
  return {
    ready: isVisibleRoot && !hasUnisolatedSibling && hasPtyBinding && hasXtermScreen,
    unavailable
  }
}

export function useActivityTerminalPortalStatus(
  target: HTMLElement | null,
  paneKey: string | null,
  forceUnavailable = false
): ActivityTerminalPortalReadiness['status'] {
  const [readiness, setReadiness] = useState<ActivityTerminalPortalReadiness>({
    target: null,
    paneKey: null,
    status: 'loading'
  })
  // Why: portal churn replaces every subscription identity, so the burst budget must outlive it.
  const readinessLatchRef = useRef<ActivityPortalReadinessLatch | null>(null)

  useLayoutEffect(() => {
    let disposed = false
    let readinessFrame: number | null = null
    let readinessReleaseTimer: number | null = null
    let pendingStatus: ActivityTerminalPortalReadiness['status'] | null = null

    // Why: coalesce observer bursts and cancel frames from stale portal subscriptions.
    const scheduleReadiness = (status: ActivityTerminalPortalReadiness['status']): void => {
      if (disposed) {
        return
      }
      pendingStatus = status
      if (readinessFrame !== null) {
        return
      }
      readinessFrame = requestAnimationFrame(() => {
        readinessFrame = null
        const nextStatus = pendingStatus
        pendingStatus = null
        if (disposed || nextStatus === null) {
          return
        }
        setReadiness((prev) =>
          prev.target === target && prev.paneKey === paneKey && prev.status === nextStatus
            ? prev
            : { target, paneKey, status: nextStatus }
        )
      })
    }

    const disposeFrame = (): void => {
      disposed = true
      if (readinessFrame !== null) {
        cancelAnimationFrame(readinessFrame)
        readinessFrame = null
      }
      if (readinessReleaseTimer !== null) {
        window.clearTimeout(readinessReleaseTimer)
        readinessReleaseTimer = null
      }
    }

    if (!target || !paneKey) {
      scheduleReadiness('loading')
      return disposeFrame
    }
    if (forceUnavailable) {
      scheduleReadiness('unavailable')
      return disposeFrame
    }

    const readinessLatch = (readinessLatchRef.current ??= createActivityPortalReadinessLatch())

    const updateReadiness = (status: ActivityTerminalPortalReadiness['status']): void => {
      const nextStatus = readinessLatch.next(status)
      scheduleReadiness(nextStatus)
      if (readinessReleaseTimer !== null) {
        window.clearTimeout(readinessReleaseTimer)
        readinessReleaseTimer = null
      }
      if (nextStatus !== status) {
        // Why: a quiet loading pane has no mutation to release the burst latch on its own.
        readinessReleaseTimer = window.setTimeout(
          checkReadiness,
          ACTIVITY_PORTAL_READINESS_BURST_WINDOW_MS
        )
      }
    }

    const checkReadiness = (): void => {
      const status = getSelectedActivityTerminalPortalStatus(target, paneKey)
      if (status.unavailable) {
        updateReadiness('unavailable')
        return
      }
      if (status.ready) {
        updateReadiness('ready')
        return
      }
      updateReadiness('loading')
    }

    checkReadiness()

    const observer = new MutationObserver(checkReadiness)
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-terminal-tab-id', 'data-leaf-id', 'data-pty-id', 'style']
    })

    return () => {
      disposeFrame()
      observer.disconnect()
    }
  }, [target, paneKey, forceUnavailable])

  return readiness.target === target && readiness.paneKey === paneKey ? readiness.status : 'loading'
}

function otherActivityTerminalSlot(
  slotId: ActivityTerminalPortalSlotId
): ActivityTerminalPortalSlotId {
  return slotId === 'primary' ? 'secondary' : 'primary'
}

function useActivityTerminalLoadingLabel(loading: boolean): boolean {
  const [visible, setVisible] = useState(false)
  const [visibleLoading, setVisibleLoading] = useState(loading)

  if (visibleLoading !== loading) {
    setVisibleLoading(loading)
    if (visible) {
      setVisible(false)
    }
  }

  useEffect(() => {
    if (!loading) {
      return
    }
    const timer = setTimeout(() => setVisible(true), ACTIVITY_TERMINAL_LOADING_LABEL_DELAY_MS)
    return () => clearTimeout(timer)
  }, [loading])

  return loading && visible
}

function agentTitle(event: ActivityEvent): string {
  if (event.state === 'done') {
    return event.entry.interrupted ? 'Agent interrupted' : 'Agent finished'
  }
  return event.state === 'waiting' ? 'Agent waiting for input' : 'Agent needs input'
}

function agentSummary(event: ActivityEvent): string {
  const prompt = getAgentRowPrimaryText(event.entry)
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

export function ActivityThreadOptionsMenu({
  compactMode,
  hasUnreadThreads,
  onCompactModeChange,
  onMarkAllThreadsRead
}: {
  compactMode: boolean
  hasUnreadThreads: boolean
  onCompactModeChange: (compactMode: boolean) => void
  onMarkAllThreadsRead: () => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Why: keep Tooltip and Dropdown from composing refs onto the same button (Radix setRef crash loop). */}
          <span className="inline-flex shrink-0">
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="size-8 shrink-0 border-input bg-transparent p-0 text-muted-foreground shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-transparent dark:hover:bg-accent dark:hover:text-accent-foreground"
                aria-label={translate(
                  'auto.components.activity.ActivityPrototypePage.db8a1878b5',
                  'Thread list options'
                )}
              >
                <MoreVertical className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {translate('auto.components.activity.ActivityPrototypePage.a472a14700', 'More options')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" sideOffset={6}>
        <DropdownMenuCheckboxItem
          checked={compactMode}
          onCheckedChange={(checked) => onCompactModeChange(checked === true)}
          onSelect={(event) => event.preventDefault()}
        >
          {translate('auto.components.activity.ActivityPrototypePage.f70e4bec47', 'Compact mode')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onMarkAllThreadsRead} disabled={!hasUnreadThreads}>
          {translate('auto.components.activity.ActivityPrototypePage.023ff75afe', 'Mark all read')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ActivityProjectLabel({ repo }: { repo: Repo | null }): React.JSX.Element {
  const label =
    repo?.displayName?.trim() ||
    translate('auto.components.activity.ActivityPrototypePage.5651b216c6', 'Unknown project')
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {repo ? <RepoBadgeMark color={repo.badgeColor} /> : null}
      <span
        className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground"
        title={label}
      >
        {label}
      </span>
    </div>
  )
}

function EventRepoBadge({ repo }: { repo: Repo | null }): React.JSX.Element | null {
  if (!repo) {
    return null
  }
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-[4px] border border-border bg-accent px-1.5 py-0.5 dark:border-border/60 dark:bg-accent/50">
      <RepoBadgeMark color={repo.badgeColor} />
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

export function getActivityThreadGroup(
  thread: AgentPaneThread,
  groupBy: ActivityGroupBy
): { key: string; label: string } {
  if (groupBy === 'status') {
    const state = threadAgentState(thread)
    if (!thread.currentAgentState && state === 'done' && thread.latestEvent?.entry.interrupted) {
      return { key: 'done:interrupted', label: threadAgentStateLabel(thread) }
    }
    return { key: state, label: threadAgentStateLabel(thread) }
  }
  if (groupBy === 'project') {
    return thread.repo
      ? { key: `project:${thread.repo.id}`, label: thread.repo.displayName }
      : {
          key: 'project:unknown',
          label: translate(
            'auto.components.activity.ActivityPrototypePage.5651b216c6',
            'Unknown project'
          )
        }
  }
  if (groupBy === 'worktree') {
    return { key: `worktree:${thread.worktree.id}`, label: thread.worktree.displayName }
  }
  return { key: `agent:${thread.agentType}`, label: formatAgentTypeLabel(thread.agentType) }
}

export function buildActivityThreadGroups(
  threads: AgentPaneThread[],
  groupBy: ActivityGroupBy
): ActivityThreadGroup[] {
  const groups: ActivityThreadGroup[] = []
  const groupIndexByKey = new Map<string, number>()
  for (const thread of threads) {
    const group = getActivityThreadGroup(thread, groupBy)
    const existingIndex = groupIndexByKey.get(group.key)
    if (existingIndex === undefined) {
      groups.push({ key: group.key, label: group.label, threads: [thread] })
      groupIndexByKey.set(group.key, groups.length - 1)
      continue
    }
    groups[existingIndex].threads.push(thread)
  }
  return groups
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
        key: id,
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
  const currentPrompt = thread.currentAgentEntry
    ? getAgentRowPrimaryText(thread.currentAgentEntry)
    : ''
  const rawCurrentPrompt = thread.currentAgentEntry?.prompt.trim() ?? ''
  const currentSummary = thread.currentAgentEntry?.lastAssistantMessage?.trim() ?? ''
  const latestEventText = latest
    ? `${agentTitle(latest)} ${agentSummary(latest)} ${agentMeta(latest)}`
    : ''
  return `${thread.paneTitle} ${getActivityThreadWorkspaceTitle(thread.worktree)} ${thread.worktree.branch ?? ''} ${thread.repo?.displayName ?? ''} ${formatAgentTypeLabel(thread.agentType)} ${stateLabel} ${currentPrompt} ${rawCurrentPrompt} ${currentSummary} ${thread.responsePreview} ${latestEventText}`.toLowerCase()
}

export const ACTIVITY_SEARCH_QUERY_MAX_BYTES = 2 * 1024

export function isActivitySearchQueryTooLarge(
  query: string,
  maxBytes = ACTIVITY_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function activityThreadMatchesSearchQuery({
  thread,
  searchQuery
}: {
  thread: AgentPaneThread
  searchQuery: string
}): boolean {
  if (isActivitySearchQueryTooLarge(searchQuery)) {
    return false
  }
  const trimmedQuery = searchQuery.trim()
  if (!trimmedQuery) {
    return true
  }
  return threadSearchText(thread).includes(trimmedQuery.toLowerCase())
}

export function isActivityFilterFocusShortcut(
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  isMac = navigator.userAgent.includes('Mac')
): boolean {
  if (event.key.toLowerCase() !== 'f' || event.shiftKey || event.altKey) {
    return false
  }
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export function shouldIgnoreActivityFilterFocusShortcutTarget(
  target: Element | null,
  terminalPortalTargets: (HTMLElement | null)[]
): boolean {
  if (!target) {
    return false
  }
  // Why: workspace terminal stays mounted while Activity is open; only the Activity-portaled terminal keeps Cmd/Ctrl+F for terminal search.
  return terminalPortalTargets.some((portalTarget) => portalTarget?.contains(target) ?? false)
}

export function handleActivityFilterFocusShortcut({
  activeElement,
  event,
  input,
  isMac,
  terminalPortalTargets
}: {
  activeElement: Element | null
  event: Pick<
    KeyboardEvent,
    | 'altKey'
    | 'ctrlKey'
    | 'key'
    | 'metaKey'
    | 'preventDefault'
    | 'shiftKey'
    | 'stopImmediatePropagation'
    | 'stopPropagation'
  >
  input: Pick<HTMLInputElement, 'focus' | 'select'> | null
  isMac?: boolean
  terminalPortalTargets: (HTMLElement | null)[]
}): boolean {
  if (shouldIgnoreActivityFilterFocusShortcutTarget(activeElement, terminalPortalTargets)) {
    return false
  }
  if (!isActivityFilterFocusShortcut(event, isMac)) {
    return false
  }
  if (!input) {
    return false
  }
  event.preventDefault()
  // Why: hidden workspace xterms can retain focus behind Activity; stop the chord before xterm forwards it to a local/SSH PTY.
  event.stopPropagation()
  event.stopImmediatePropagation()
  input.focus()
  input.select()
  return true
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
      {group.state ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          <AgentStateDot state={group.state} size="sm" />
        </span>
      ) : null}
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
  canJump,
  compactMode
}: {
  thread: AgentPaneThread
  selected: boolean
  onSelect: () => void
  onJump: () => void
  onMarkUnread: () => void
  canJump: boolean
  compactMode: boolean
}): React.JSX.Element {
  const renderedResponsePreview = activityThreadResponseRenderPreview({
    responsePreview: thread.responsePreview
  })
  const workspaceTitle = getActivityThreadWorkspaceTitle(thread.worktree)
  const taskTitle = thread.paneTitle
  const agentLabel = formatAgentTypeLabel(thread.agentType)
  const showStatusPreview =
    !compactMode &&
    renderedResponsePreview.length > 0 &&
    renderedResponsePreview !== taskTitle &&
    renderedResponsePreview !== workspaceTitle
  return (
    <div
      data-current={selected ? 'true' : undefined}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        // Why: markdown responses can contain links; keyboard activation on a nested link follows the link instead of selecting the row.
        if (isEventFromNestedInteractiveElement(event.target, event.currentTarget)) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        // Why (WorktreeCard cues): selected = tint+shadow, beats hover; unread = weight + left bar only; stacking all three confused selected vs unread on hover.
        // Why (asymmetric padding): title leading-snug adds ~3px above cap-height; smaller top pad evens the row.
        'group relative flex w-full cursor-pointer flex-col gap-1 border-b border-border px-3 pt-2.5 pb-3 text-left transition-colors',
        selected
          ? 'bg-black/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:bg-white/[0.10] dark:shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
          : 'hover:bg-accent/40'
      )}
    >
      {thread.unread ? (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-primary" />
      ) : null}
      <div className="flex min-w-0 items-start gap-2">
        <span className="inline-flex shrink-0 items-start gap-1">
          <ThreadAgentStateIndicator thread={thread} />
          <span className="inline-flex shrink-0 pt-px">
            <AgentIcon agent={agentTypeToIconAgent(thread.agentType)} size={14} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1 space-y-0.5">
              <ActivityProjectLabel repo={thread.repo} />
              <div
                className={cn(
                  'min-w-0 text-[13px] leading-snug',
                  compactMode ? 'truncate' : 'line-clamp-2 break-words',
                  thread.unread ? 'font-semibold text-foreground' : 'font-medium text-foreground'
                )}
                title={workspaceTitle}
              >
                {workspaceTitle}
              </div>
              {taskTitle !== workspaceTitle ? (
                <div
                  className={cn(
                    'min-w-0 text-[12px] leading-snug text-muted-foreground',
                    compactMode ? 'truncate' : 'line-clamp-2 break-words'
                  )}
                  title={taskTitle}
                >
                  {taskTitle}
                </div>
              ) : null}
              {showStatusPreview ? (
                <CommentMarkdown
                  content={renderedResponsePreview}
                  className={cn(
                    'h-[1lh] min-w-0 overflow-hidden truncate whitespace-nowrap text-[11px] font-normal leading-snug text-muted-foreground/80',
                    '[&_*]:inline [&_*]:!m-0 [&_*]:!p-0 [&_*]:!whitespace-nowrap [&_br]:hidden [&_ol]:list-none [&_ul]:list-none'
                  )}
                  title={thread.responsePreview}
                />
              ) : null}
              <div className="flex min-w-0 items-center gap-1.5 pt-0.5">
                <span className="shrink-0 text-[10px] text-muted-foreground/80">{agentLabel}</span>
                {canJump ? (
                  <span
                    className={cn(
                      'ml-auto inline-flex shrink-0 items-center transition-opacity',
                      'can-hover:pointer-events-none can-hover:invisible can-hover:opacity-0',
                      'group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100'
                    )}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-xs"
                          aria-label={translate(
                            'auto.components.activity.ActivityPrototypePage.4616ea39fd',
                            'Jump to workspace'
                          )}
                          onClick={(event) => {
                            event.stopPropagation()
                            onJump()
                          }}
                          onMouseDown={(event) => event.stopPropagation()}
                        >
                          <ExternalLink className="size-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left">
                        {translate(
                          'auto.components.activity.ActivityPrototypePage.4616ea39fd',
                          'Jump to workspace'
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </span>
                ) : null}
              </div>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1.5 pt-px">
              <span className="inline-flex size-4 shrink-0 items-center justify-center">
                {thread.unread ? (
                  <FilledBellIcon
                    className="size-[13px] shrink-0 text-amber-500 drop-shadow-sm"
                    aria-label={translate(
                      'auto.components.activity.ActivityPrototypePage.beb2c19173',
                      'Unread'
                    )}
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
                        aria-label={translate(
                          'auto.components.activity.ActivityPrototypePage.59b131fbd9',
                          'Mark thread unread'
                        )}
                      >
                        <Bell className="size-3 text-muted-foreground/40 can-hover:opacity-0 transition-opacity group-hover:opacity-100 group-hover/unread:opacity-100" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      {translate(
                        'auto.components.activity.ActivityPrototypePage.59b131fbd9',
                        'Mark thread unread'
                      )}
                    </TooltipContent>
                  </Tooltip>
                )}
              </span>
              <EventTime timestamp={thread.latestTimestamp} />
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ActivityPrototypePage(): React.JSX.Element {
  // Why: the unread-only toggle is a sticky viewing mode, not a per-visit query — restore it across page opens.
  const [readFilter, setReadFilter] = useState<ThreadReadFilter>(readStoredActivityReadFilter)
  const [groupBy, setGroupBy] = useState<ActivityGroupBy>('status')
  const [query, setQuery] = useState('')
  const activityFilterInputRef = useRef<HTMLInputElement | null>(null)
  const [compactMode, setCompactMode] = useState(false)
  const [selectedPaneKey, setSelectedPaneKey] = useState<string | null>(null)
  const [displayedPaneKey, setDisplayedPaneKey] = useState<string | null>(null)
  const [activePortalSlotId, setActivePortalSlotId] =
    useState<ActivityTerminalPortalSlotId>('primary')
  const [primaryPortalTargetEl, setPrimaryPortalTargetEl] = useState<HTMLElement | null>(null)
  const [secondaryPortalTargetEl, setSecondaryPortalTargetEl] = useState<HTMLElement | null>(null)
  // Why (default width): thread cards are the primary surface; 480px lets prompts fill line-clamp-3 and keeps the per-card actions readable.
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
      migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
      retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
      tabsByWorktree: s.tabsByWorktree,
      worktreeMap: getWorktreeMapFromState(s),
      repoMap: getRepoMapFromState(s),
      acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey,
      acknowledgeAgents: s.acknowledgeAgents,
      unacknowledgeAgents: s.unacknowledgeAgents,
      generatedTitlesEnabled: s.settings?.tabAutoGenerateTitle === true
    }))
  )
  // Why: agentStatusEpoch is a dep (not used in the body) so the memo recomputes when freshness boundaries expire even without new PTY data.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)

  const { events: allEvents, liveAgentByPaneKey } = useMemo(
    () =>
      buildActivityEvents({
        agentStatusByPaneKey: storeData.agentStatusByPaneKey,
        migrationUnsupportedByPtyId: storeData.migrationUnsupportedByPtyId,
        retainedAgentsByPaneKey: storeData.retainedAgentsByPaneKey,
        tabsByWorktree: storeData.tabsByWorktree,
        worktreeMap: storeData.worktreeMap,
        repoMap: storeData.repoMap,
        acknowledgedAgentsByPaneKey: storeData.acknowledgedAgentsByPaneKey,
        // Why: Date.now() is read in the memo body (not a dep) so stale-decay recomputes when agentStatusEpoch ticks, not on wall-clock time.
        now: Date.now()
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeData, agentStatusEpoch]
  )

  const allThreads = useMemo(
    () =>
      buildAgentPaneThreads({
        events: allEvents,
        liveAgentByPaneKey,
        generatedTitlesEnabled: storeData.generatedTitlesEnabled
      }),
    [allEvents, liveAgentByPaneKey, storeData.generatedTitlesEnabled]
  )
  const selectedPaneKeyIsLive =
    selectedPaneKey === null || allThreads.some((thread) => thread.paneKey === selectedPaneKey)
  const effectiveSelectedPaneKey = selectedPaneKeyIsLive ? selectedPaneKey : null
  if (!selectedPaneKeyIsLive) {
    // Why: rows disappear when agent retention or tab state changes; clear stale selection before detail/portal rendering targets it.
    setSelectedPaneKey(null)
  }

  const visibleThreads = useMemo(() => {
    const normalizedQuery = isActivitySearchQueryTooLarge(query) ? null : query.trim().toLowerCase()
    return allThreads.filter((thread) => {
      // Why: keep the just-selected thread visible after auto-mark-read flips it to read, else unread-only mode makes the clicked row vanish from the list.
      if (
        readFilter === 'unread' &&
        !thread.unread &&
        thread.paneKey !== effectiveSelectedPaneKey
      ) {
        return false
      }
      if (normalizedQuery === null) {
        return false
      }
      return activityThreadMatchesSearchQuery({ thread, searchQuery: normalizedQuery })
    })
  }, [allThreads, readFilter, query, effectiveSelectedPaneKey])
  const visibleThreadGroups = useMemo(
    () => buildActivityThreadGroups(visibleThreads, groupBy),
    [visibleThreads, groupBy]
  )

  const selectedThread = effectiveSelectedPaneKey
    ? (allThreads.find((thread) => thread.paneKey === effectiveSelectedPaneKey) ?? null)
    : null
  const selectedTabId = selectedThread?.tab.id ?? null
  // Why: repo-less terminal buckets can produce Activity rows, but the workspace Terminal tree only portals real worktrees.
  const selectedHasLiveTab =
    selectedThread && selectedTabId && storeData.worktreeMap.has(selectedThread.worktree.id)
      ? (storeData.tabsByWorktree[selectedThread.worktree.id] ?? []).some(
          (tab) => tab.id === selectedTabId
        )
      : false
  const displayedThread = displayedPaneKey
    ? (allThreads.find((thread) => thread.paneKey === displayedPaneKey) ?? null)
    : null
  const displayedTabId = displayedThread?.tab.id ?? null
  const displayedHasLiveTab =
    displayedThread && displayedTabId && storeData.worktreeMap.has(displayedThread.worktree.id)
      ? (storeData.tabsByWorktree[displayedThread.worktree.id] ?? []).some(
          (tab) => tab.id === displayedTabId
        )
      : false
  const { visibleThread, stagedThread } = reconcileActivityPortalThreads({
    selectedThread,
    displayedThread,
    selectedHasLiveTab: Boolean(selectedHasLiveTab),
    displayedHasLiveTab: Boolean(displayedHasLiveTab)
  })
  const inactivePortalSlotId = otherActivityTerminalSlot(activePortalSlotId)
  const portalTargetBySlot = {
    primary: primaryPortalTargetEl,
    secondary: secondaryPortalTargetEl
  } satisfies Record<ActivityTerminalPortalSlotId, HTMLElement | null>
  const activePortalTargetEl = portalTargetBySlot[activePortalSlotId]
  const inactivePortalTargetEl = portalTargetBySlot[inactivePortalSlotId]
  const visiblePortalStatus = useActivityTerminalPortalStatus(
    activePortalTargetEl,
    visibleThread?.paneKey ?? null,
    visibleThread?.migrationUnsupportedPtyId !== undefined
  )
  const stagedPortalStatus = useActivityTerminalPortalStatus(
    inactivePortalTargetEl,
    stagedThread?.paneKey ?? null,
    stagedThread?.migrationUnsupportedPtyId !== undefined
  )
  const visiblePortalReady = visiblePortalStatus === 'ready'
  const visiblePortalUnavailable = visiblePortalStatus === 'unavailable'
  const stagedPortalReady = stagedPortalStatus === 'ready'
  const stagedPortalUnavailable = stagedPortalStatus === 'unavailable'
  const showTerminalLoadingLabel = useActivityTerminalLoadingLabel(
    Boolean(visibleThread && !stagedThread && !visiblePortalReady)
  )

  const setPrimaryPortalTarget = useCallback((target: HTMLElement | null): void => {
    setPrimaryPortalTargetEl(target)
  }, [])

  const setSecondaryPortalTarget = useCallback((target: HTMLElement | null): void => {
    setSecondaryPortalTargetEl(target)
  }, [])

  // Why (no flash): anchor the portal to the selected thread's ids; selectThread's multi-step store update can briefly reflect a stale "last active tab" (wrong-terminal flash).
  // Why useMemo: stable descriptor identity so subscribers keep React.memo bail-outs; inactive descriptor stages the next terminal at the same size.
  const portalDescriptors = useMemo(() => {
    const descriptors: ActivityTerminalPortalTarget[] = []
    if (visibleThread && activePortalTargetEl) {
      descriptors.push({
        slotId: activePortalSlotId,
        requestToken: `${activePortalSlotId}:${visibleThread.paneKey}`,
        target: activePortalTargetEl,
        worktreeId: visibleThread.worktree.id,
        tabId: visibleThread.tab.id,
        paneKey: visibleThread.paneKey,
        forceUnavailable: visibleThread.migrationUnsupportedPtyId !== undefined,
        active: true
      })
    }
    if (stagedThread && inactivePortalTargetEl) {
      descriptors.push({
        slotId: inactivePortalSlotId,
        requestToken: `${inactivePortalSlotId}:${stagedThread.paneKey}`,
        target: inactivePortalTargetEl,
        worktreeId: stagedThread.worktree.id,
        tabId: stagedThread.tab.id,
        paneKey: stagedThread.paneKey,
        forceUnavailable: stagedThread.migrationUnsupportedPtyId !== undefined,
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

  // Why: swap-staged makes the displayed thread selected, so this branch cannot repeat by itself.
  useLayoutEffect(() => {
    const swap = resolveActivityPortalSwap({
      selectedThread,
      selectedHasLiveTab: Boolean(selectedHasLiveTab),
      visibleThread,
      stagedThread,
      visiblePortalReady,
      stagedPortalReady,
      stagedPortalUnavailable
    })
    if (swap?.kind === 'clear') {
      setDisplayedPaneKey(null)
      return
    }
    if (swap?.kind === 'swap-staged') {
      // Why: a stale selected pane must swap to the unavailable state, not leave the previous pane visible under the new row.
      setActivePortalSlotId(inactivePortalSlotId)
      setDisplayedPaneKey(swap.paneKey)
      return
    }
    if (swap?.kind === 'settle-visible') {
      setDisplayedPaneKey(swap.paneKey)
    }
  }, [
    inactivePortalSlotId,
    selectedHasLiveTab,
    selectedThread,
    stagedPortalUnavailable,
    stagedPortalReady,
    stagedThread,
    visiblePortalReady,
    visibleThread
  ])

  // Why useLayoutEffect (not useEffect): publish before paint so Terminal's portal subscriber rerenders in the same commit, else the stale target flashes on screen.
  // Why no cleanup-to-null on each change: it forces the portal through null on every switch, flashing the workspace pane; null only on unmount (effect below).
  // oxlint-disable-next-line react-doctor/no-derived-state-effect -- Why: this publishes portal descriptors to Terminal's external portal store before paint.
  useLayoutEffect(() => {
    setActivityTerminalPortals(portalDescriptors)
  }, [portalDescriptors])

  const setActivityPageRef = useCallback((node: HTMLDivElement | null): void => {
    if (!node) {
      // Why: portal cleanup must happen only on page unmount; clearing on descriptor changes flashes the workspace pane behind the activity slot.
      setActivityTerminalPortals([])
    }
  }, [])

  useEffect(() => {
    const focusActivityFilter = (event: KeyboardEvent): void => {
      handleActivityFilterFocusShortcut({
        activeElement: document.activeElement,
        event,
        input: activityFilterInputRef.current,
        terminalPortalTargets: [activePortalTargetEl, inactivePortalTargetEl]
      })
    }

    window.addEventListener('keydown', focusActivityFilter, { capture: true })
    return () => window.removeEventListener('keydown', focusActivityFilter, { capture: true })
  }, [activePortalTargetEl, inactivePortalTargetEl])

  const markThreadRead = (thread: AgentPaneThread): void => {
    storeData.acknowledgeAgents([thread.paneKey])
  }

  const markThreadUnread = (thread: AgentPaneThread): void => {
    storeData.unacknowledgeAgents([thread.paneKey])
  }

  const activateThreadTerminal = (thread: AgentPaneThread): void => {
    const state = useAppStore.getState()
    const worktree = getWorktreeMapFromState(state).get(thread.worktree.id)
    if (!worktree) {
      return
    }
    // Why: retained-agent threads can outlive their tab; without a live tab, reorienting the workspace and focusing a dead tab id would just confuse the user.
    const liveTabs = state.tabsByWorktree[worktree.id] ?? []
    const hasLiveTab = liveTabs.some((t) => t.id === thread.tab.id)
    if (!hasLiveTab) {
      return
    }
    if (state.activeRepoId !== worktree.repoId) {
      state.setActiveRepo(worktree.repoId)
    }
    if (state.activeWorktreeId !== worktree.id) {
      state.setActiveWorktree(worktree.id)
    }
    state.setActiveTabType('terminal')
    const parsed = parsePaneKey(thread.paneKey)
    activateTabAndFocusPane(
      thread.tab.id,
      parsed && parsed.tabId === thread.tab.id ? parsed.leafId : null,
      { scrollToBottomIfOutputSinceLastView: true }
    )
  }

  const selectThread = (thread: AgentPaneThread): void => {
    setSelectedPaneKey(thread.paneKey)
    activateThreadTerminal(thread)
  }

  useEffect(() => {
    if (
      !selectedThread ||
      !selectedThread.unread ||
      stagedThread ||
      selectedThread.paneKey !== effectiveSelectedPaneKey
    ) {
      return
    }
    const selectedThreadHasDetailOnlyView =
      !selectedHasLiveTab || selectedThread.migrationUnsupportedPtyId !== undefined
    const selectedThreadIsVisibleTerminal =
      visibleThread?.paneKey === effectiveSelectedPaneKey && visiblePortalReady
    if (selectedThreadHasDetailOnlyView || selectedThreadIsVisibleTerminal) {
      storeData.acknowledgeAgents([selectedThread.paneKey])
    }
  }, [
    selectedHasLiveTab,
    effectiveSelectedPaneKey,
    selectedThread,
    stagedThread,
    storeData,
    visiblePortalReady,
    visibleThread
  ])

  const jumpToWorkspace = (thread: AgentPaneThread): void => {
    const state = useAppStore.getState()
    if (!getWorktreeMapFromState(state).has(thread.worktree.id)) {
      return
    }
    markThreadRead(thread)
    activateAndRevealWorktree(thread.worktree.id)
  }

  const updateReadFilter = (next: ThreadReadFilter): void => {
    setReadFilter(next)
    try {
      window.localStorage.setItem(ACTIVITY_READ_FILTER_STORAGE_KEY, next)
    } catch {
      // Best-effort; the filter falls back to 'all' next mount if storage is unavailable.
    }
  }

  const hasUnreadThreads = allThreads.some((thread) => thread.unread)

  const markAllThreadsRead = (): void => {
    const unreadKeys = allThreads.filter((t) => t.unread).map((t) => t.paneKey)
    if (unreadKeys.length === 0) {
      return
    }
    storeData.acknowledgeAgents(unreadKeys)
  }

  // Why (page padding): no top/horizontal padding so the page reaches the window edges; the titlebar and the right pane's title row (pt-2) supply the top spacing.
  return (
    <div ref={setActivityPageRef} className="flex h-full min-h-0 flex-col bg-background pb-3">
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
                  ref={activityFilterInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={translate(
                    'auto.components.activity.ActivityPrototypePage.795cbf26e2',
                    'Filter...'
                  )}
                  className="h-8 w-full pl-7 text-xs"
                />
              </div>
              <Select
                value={groupBy}
                onValueChange={(value) => setGroupBy(value as ActivityGroupBy)}
              >
                <SelectTrigger
                  size="sm"
                  className="h-8 w-[128px] shrink-0 px-2 text-xs"
                  aria-label={translate(
                    'auto.components.activity.ActivityPrototypePage.770d458144',
                    'Group agent activity by'
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="status">
                    {translate(
                      'auto.components.activity.ActivityPrototypePage.4a3986b200',
                      'Status'
                    )}
                  </SelectItem>
                  <SelectItem value="project">
                    {translate(
                      'auto.components.activity.ActivityPrototypePage.8c3b621ddf',
                      'Project'
                    )}
                  </SelectItem>
                  <SelectItem value="worktree">
                    {translate(
                      'auto.components.activity.ActivityPrototypePage.b29191b3e0',
                      'Worktree'
                    )}
                  </SelectItem>
                  <SelectItem value="agent">
                    {translate(
                      'auto.components.activity.ActivityPrototypePage.f6396e1f85',
                      'Agent'
                    )}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Toggle
                    pressed={readFilter === 'unread'}
                    onPressedChange={(pressed) => updateReadFilter(pressed ? 'unread' : 'all')}
                    variant="outline"
                    size="sm"
                    className={cn(
                      'size-8 shrink-0 p-0',
                      readFilter === 'unread'
                        ? '!border-primary !bg-primary !text-primary-foreground shadow-xs ring-2 ring-primary/35 hover:!bg-primary/90 hover:!text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    aria-label={translate(
                      'auto.components.activity.ActivityPrototypePage.d1a88df9a8',
                      'Show unread threads only'
                    )}
                  >
                    <BellDot className="size-3.5" />
                  </Toggle>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {translate(
                    'auto.components.activity.ActivityPrototypePage.d1a88df9a8',
                    'Show unread threads only'
                  )}
                </TooltipContent>
              </Tooltip>
              {/* Why (overflow menu): "Mark all read" is low-frequency and destructive-feeling; behind `…` keeps the toolbar on the frequent Filter + unread toggle. */}
              <ActivityThreadOptionsMenu
                compactMode={compactMode}
                hasUnreadThreads={hasUnreadThreads}
                onCompactModeChange={setCompactMode}
                onMarkAllThreadsRead={markAllThreadsRead}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
            {visibleThreadGroups.map((group) => (
              <section
                key={group.key}
                aria-label={translate(
                  'auto.components.activity.ActivityPrototypePage.a2b4437bfb',
                  '{{value0}} activity',
                  { value0: group.label }
                )}
              >
                <ActivityStatusGroupHeader group={group} />
                {group.threads.map((thread) => (
                  <ThreadRow
                    key={thread.paneKey}
                    thread={thread}
                    selected={thread.paneKey === selectedThread?.paneKey}
                    onSelect={() => selectThread(thread)}
                    onJump={() => jumpToWorkspace(thread)}
                    onMarkUnread={() => markThreadUnread(thread)}
                    canJump={storeData.worktreeMap.has(thread.worktree.id)}
                    compactMode={compactMode}
                  />
                ))}
              </section>
            ))}
            {visibleThreads.length === 0 ? (
              <div className="px-3 py-8 text-sm text-muted-foreground">
                {translate(
                  'auto.components.activity.ActivityPrototypePage.7cd632006b',
                  'No agent activity matches these filters.'
                )}
              </div>
            ) : null}
          </div>
          <div
            aria-label={translate(
              'auto.components.activity.ActivityPrototypePage.443690186e',
              'Resize activity thread list'
            )}
            title={translate(
              'auto.components.activity.ActivityPrototypePage.866083500b',
              'Drag to resize'
            )}
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
              {/* Why (no header action button): per-card hover actions (Mark unread, Open) are the primary controls now, so the header keeps just the thread identity. */}
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
              {/* Why: Terminal stays mounted in the hidden workspace tree; this target moves that existing TerminalPane here instead of spawning a second PTY/xterm owner. */}
              {(() => {
                // Why: retained threads can outlive their tab; portal needs a live TerminalPane to render into.
                if (!selectedHasLiveTab) {
                  return (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                      <TerminalSquare className="size-7" />
                      {storeData.worktreeMap.has(selectedThread.worktree.id)
                        ? translate(
                            'auto.components.activity.ActivityPrototypePage.afdc2139a8',
                            'Agent terminal closed. Open a new terminal in this workspace to continue.'
                          )
                        : translate(
                            'auto.components.activity.ActivityPrototypePage.22b22034bc',
                            'Standalone terminal unavailable in Activity.'
                          )}
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
                        {visiblePortalUnavailable ? (
                          <div className="ml-3 mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-background/85 px-2 py-1 text-xs text-muted-foreground shadow-xs">
                            <span className="h-3 w-1.5 rounded-sm bg-muted-foreground/70" />
                            <span>
                              {translate(
                                'auto.components.activity.ActivityPrototypePage.8de7c5beaa',
                                'Terminal unavailable'
                              )}
                            </span>
                          </div>
                        ) : showTerminalLoadingLabel ? (
                          <div className="ml-3 mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-background/85 px-2 py-1 text-xs text-muted-foreground shadow-xs">
                            <span className="h-3 w-1.5 animate-pulse rounded-sm bg-muted-foreground/70" />
                            <span>
                              {translate(
                                'auto.components.activity.ActivityPrototypePage.1b633f5c1e',
                                'Connecting terminal...'
                              )}
                            </span>
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
                  {translate(
                    'auto.components.activity.ActivityPrototypePage.e3db9892f6',
                    'No activity yet.'
                  )}
                </>
              ) : (
                <>
                  <TerminalSquare className="size-7" />
                  {translate(
                    'auto.components.activity.ActivityPrototypePage.cf780197a1',
                    'Select an agent to view its activity'
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
