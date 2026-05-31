/* eslint-disable max-lines -- Why: this page owns the automations list/detail
 * orchestration while the form and detail presentation live in sibling files. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CalendarClock,
  Check,
  Clock,
  Eye,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { filterEnabledTuiAgents, isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import type { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { useRepoMap, useWorktreeMap } from '@/store/selectors'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type {
  Automation,
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager,
  ExternalAutomationRun,
  AutomationRun,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type { Worktree } from '../../../../shared/types'
import { getWorktreePathBasenameFromId } from '../../../../shared/worktree-id'
import {
  buildAutomationRrule,
  formatAutomationSchedule,
  isValidAutomationCronSchedule,
  isValidAutomationSchedule,
  tryParseAutomationRrule
} from '../../../../shared/automation-schedules'
import {
  formatAutomationDateTimeWithRelative,
  getAutomationRunStatusLabel,
  getAutomationRunStatusVariant
} from './automation-page-parts'
import {
  formatAutomationCost,
  formatAutomationTokens,
  summarizeAutomationRunUsage
} from './automation-usage-model'
import {
  canRerunAutomationRun,
  getAutomationRerunPendingRemainingMs,
  getAutomationRunViewState
} from './automation-run-view-state'
import { getAutomationRunWorkspaceDisplay } from './automation-run-workspace-display'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { AutomationDetail } from './AutomationDetail'
import { HermesCronOutputView } from './HermesCronOutputView'
import {
  AutomationEditorDialog,
  type AutomationCreateTarget,
  type AutomationDraft
} from './AutomationEditorDialog'
import { AutomationRunPageFrame } from './AutomationRunPageFrame'
import { AutomationRunHistory } from './AutomationRunHistory'
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from './automation-templates'
import { getExternalAutomationScheduleDisplay } from './external-automation-schedule-display'
import { ExternalAutomationManagers } from './ExternalAutomationManagers'
import type { FetchExternalAutomationRuns } from './ExternalAutomationRunTable'

const AGENTS = AGENT_CATALOG.map((agent) => agent.id)
const DEFAULT_TIME = '09:00'
const AUTOMATIONS_CHANGED_EVENT = 'orca:automations-changed'
type AutomationPaneTab = 'overview' | 'runs'

type ExternalAutomationListEntry =
  | {
      kind: 'job'
      key: string
      manager: ExternalAutomationManager
      job: ExternalAutomationJob
    }
  | {
      kind: 'source'
      key: string
      manager: ExternalAutomationManager
    }

type SelectedExternalRunPage = {
  manager: ExternalAutomationManager
  job: ExternalAutomationJob
  run: ExternalAutomationRun
}

function getDefaultWorktree(worktrees: readonly Worktree[]): Worktree | null {
  return worktrees.find((worktree) => worktree.isMainWorktree) ?? worktrees[0] ?? null
}

function formatTimeInput(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function parseDraftTime(time: string): { hour: number; minute: number } {
  const [rawHour, rawMinute] = time.split(':').map((part) => Number(part))
  return {
    hour: Number.isFinite(rawHour) ? rawHour : 9,
    minute: Number.isFinite(rawMinute) ? rawMinute : 0
  }
}

function buildHermesCronSchedule(draft: AutomationDraft): string {
  if (draft.preset === 'custom') {
    return draft.customSchedule.trim()
  }
  const { hour, minute } = parseDraftTime(draft.time)
  if (draft.preset === 'hourly') {
    return `${minute} * * * *`
  }
  if (draft.preset === 'daily') {
    return `${minute} ${hour} * * *`
  }
  if (draft.preset === 'weekdays') {
    return `${minute} ${hour} * * 1-5`
  }
  return `${minute} ${hour} * * ${Number(draft.dayOfWeek)}`
}

function getAgentLabel(agentId: string): string {
  return AGENT_CATALOG.find((agent) => agent.id === agentId)?.label ?? agentId
}

function getExternalAutomationKey(
  manager: ExternalAutomationManager,
  job: ExternalAutomationJob
): string {
  return `${manager.id}:${job.id}`
}

function getExternalAutomationSourceKey(manager: ExternalAutomationManager): string {
  return `${manager.id}:source`
}

function formatExternalDate(value: string | null, now: number): string {
  if (!value) {
    return 'Never'
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return value
  }
  return formatAutomationDateTimeWithRelative(parsed, now)
}

function getExternalProviderLabel(manager: ExternalAutomationManager): string {
  return manager.provider === 'hermes' ? 'Hermes' : 'OpenClaw'
}

function getExternalTargetKindLabel(manager: ExternalAutomationManager): string {
  return manager.target.type === 'ssh' ? 'Remote SSH' : 'Local'
}

function isSshConnectionBusy(status: SshConnectionStatus | undefined): boolean {
  return status === 'connecting' || status === 'deploying-relay' || status === 'reconnecting'
}

function getExternalRunStatusLabel(run: ExternalAutomationRun): string {
  switch (run.status) {
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'unknown':
      return 'Unknown'
  }
}

function getExternalRunStatusVariant(
  run: ExternalAutomationRun
): React.ComponentProps<typeof Badge>['variant'] {
  switch (run.status) {
    case 'completed':
      return 'secondary'
    case 'failed':
      return 'destructive'
    case 'unknown':
      return 'outline'
  }
}

function getExternalRunContent(run: ExternalAutomationRun): string {
  return run.outputContent ?? run.error ?? run.outputPreview ?? 'No output content available.'
}

function getAutomationRunContent(run: AutomationRun): string {
  const savedOutput = run.outputSnapshot?.content.trim()
  if (savedOutput) {
    return run.outputSnapshot?.content ?? savedOutput
  }
  return run.error ?? run.usage?.unavailableMessage ?? 'No output content available.'
}

function isMissingExternalRunsApiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /listExternalRuns|automations:listExternalRuns|No handler registered/i.test(message)
}

async function waitForAutomationRerunPendingVisibility(pendingStartedAt: number): Promise<void> {
  const remainingMs = getAutomationRerunPendingRemainingMs({ pendingStartedAt })
  if (remainingMs <= 0) {
    return
  }
  await new Promise<void>((resolve) => window.setTimeout(resolve, remainingMs))
}

export default function AutomationsPage(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const unifiedTabsByWorktree = useAppStore((s) => s.unifiedTabsByWorktree)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const fetchAllWorktrees = useAppStore((s) => s.fetchAllWorktrees)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const closeAutomationsPage = useAppStore((s) => s.closeAutomationsPage)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const retainedAgentsByPaneKey = useAppStore((s) => s.retainedAgentsByPaneKey)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const settings = useAppStore((s) => s.settings)
  const selectedId = useAppStore((s) => s.selectedAutomationId)
  const setSelectedId = useAppStore((s) => s.setSelectedAutomationId)
  const repoMap = useRepoMap()
  const worktreeMap = useWorktreeMap()
  const enabledAgents = filterEnabledTuiAgents(AGENTS, settings?.disabledTuiAgents)
  const defaultAgent =
    settings?.defaultTuiAgent &&
    settings.defaultTuiAgent !== 'blank' &&
    isTuiAgentEnabled(settings.defaultTuiAgent, settings.disabledTuiAgents)
      ? settings.defaultTuiAgent
      : (enabledAgents[0] ?? AGENTS[0])

  const [automations, setAutomations] = useState<Automation[]>([])
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [selectedAutomationRuns, setSelectedAutomationRuns] = useState<{
    automationId: string | null
    runs: AutomationRun[]
  }>({ automationId: null, runs: [] })
  const [externalManagers, setExternalManagers] = useState<ExternalAutomationManager[]>([])
  const [externalActionKey, setExternalActionKey] = useState<string | null>(null)
  const [rerunRunIdsInFlight, setRerunRunIdsInFlight] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createTarget, setCreateTarget] = useState<AutomationCreateTarget>('orca')
  const [editingAutomationId, setEditingAutomationId] = useState<string | null>(null)
  const [relativeNow, setRelativeNow] = useState(Date.now())
  const [activePaneTab, setActivePaneTab] = useState<AutomationPaneTab>('overview')
  const [selectedAutomationRunPageId, setSelectedAutomationRunPageId] = useState<string | null>(
    null
  )
  const [selectedExternalKey, setSelectedExternalKey] = useState<string | null>(null)
  const [selectedExternalRunPage, setSelectedExternalRunPage] =
    useState<SelectedExternalRunPage | null>(null)
  const [connectingExternalSourceKey, setConnectingExternalSourceKey] = useState<string | null>(
    null
  )
  const [draftAtOpen, setDraftAtOpen] = useState<AutomationDraft | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null)
  const [externalDeleteTarget, setExternalDeleteTarget] = useState<{
    manager: ExternalAutomationManager
    job: ExternalAutomationJob
  } | null>(null)
  const [editingExternalTarget, setEditingExternalTarget] = useState<{
    manager: ExternalAutomationManager
    job: ExternalAutomationJob
  } | null>(null)
  const [dontAskDeleteAgain, setDontAskDeleteAgain] = useState(false)
  const editRequestRef = useRef(0)
  const deleteConfirmButtonRef = useRef<HTMLButtonElement>(null)
  const completionInFlightRef = useRef<Set<string>>(new Set())
  const rerunRunIdsInFlightRef = useRef<Set<string>>(new Set())
  const workspaceNameCacheRef = useRef<Map<string, string>>(new Map())
  const [draft, setDraft] = useState<AutomationDraft>({
    name: '',
    prompt: '',
    agentId: defaultAgent,
    projectId: '',
    workspaceMode: 'existing',
    workspaceId: '',
    baseBranch: '',
    reuseSession: false,
    preset: 'weekdays',
    time: DEFAULT_TIME,
    dayOfWeek: '1',
    customSchedule: '',
    missedRunGraceMinutes: '720',
    scheduleWarning: null
  })

  const externalAutomationEntries = useMemo<ExternalAutomationListEntry[]>(
    () =>
      externalManagers.flatMap((manager): ExternalAutomationListEntry[] => {
        if (manager.jobs.length === 0) {
          if (
            manager.provider === 'hermes' &&
            (manager.status === 'unavailable' || manager.error)
          ) {
            return [
              {
                kind: 'source' as const,
                key: getExternalAutomationSourceKey(manager),
                manager
              }
            ]
          }
          return []
        }
        return manager.jobs.map((job) => ({
          kind: 'job' as const,
          key: getExternalAutomationKey(manager, job),
          manager,
          job
        }))
      }),
    [externalManagers]
  )
  const selectedExternal =
    externalAutomationEntries.find((entry) => entry.key === selectedExternalKey) ??
    (automations.length === 0 ? (externalAutomationEntries[0] ?? null) : null)
  const selected =
    selectedExternal === null
      ? (automations.find((automation) => automation.id === selectedId) ?? automations[0] ?? null)
      : null
  const runsWithWorkspaceNames = useMemo(
    () =>
      runs.map((run) => {
        if (!run.workspaceId || run.workspaceDisplayName?.trim()) {
          return run
        }
        const displayName =
          worktreeMap.get(run.workspaceId)?.displayName ??
          workspaceNameCacheRef.current.get(run.workspaceId) ??
          getWorktreePathBasenameFromId(run.workspaceId)
        const trimmedDisplayName = displayName?.trim()
        return trimmedDisplayName ? { ...run, workspaceDisplayName: trimmedDisplayName } : run
      }),
    [runs, worktreeMap]
  )
  const selectedAutomationRunsWithWorkspaceNames = useMemo(
    () =>
      selectedAutomationRuns.runs.map((run) => {
        if (!run.workspaceId || run.workspaceDisplayName?.trim()) {
          return run
        }
        const displayName =
          worktreeMap.get(run.workspaceId)?.displayName ??
          workspaceNameCacheRef.current.get(run.workspaceId) ??
          getWorktreePathBasenameFromId(run.workspaceId)
        const trimmedDisplayName = displayName?.trim()
        return trimmedDisplayName ? { ...run, workspaceDisplayName: trimmedDisplayName } : run
      }),
    [selectedAutomationRuns.runs, worktreeMap]
  )
  // Why: keep the detail tab scoped even while the selected-run fetch catches up.
  const selectedRunsSource =
    selected && selectedAutomationRuns.automationId === selected.id
      ? selectedAutomationRunsWithWorkspaceNames
      : runsWithWorkspaceNames
  const selectedRuns = selected
    ? selectedRunsSource.filter((run) => run.automationId === selected.id)
    : []
  const selectedAutomationRunPage = selectedAutomationRunPageId
    ? (selectedRuns.find((run) => run.id === selectedAutomationRunPageId) ?? null)
    : null
  const worktrees = useMemo(
    () => worktreesByRepo[draft.projectId] ?? [],
    [draft.projectId, worktreesByRepo]
  )

  useEffect(() => {
    for (const [workspaceId, worktree] of worktreeMap) {
      const displayName = worktree.displayName.trim()
      if (displayName) {
        workspaceNameCacheRef.current.set(workspaceId, displayName)
      }
    }
  }, [worktreeMap])
  const activeTerminalTabIds = useMemo(() => {
    const ids = new Set<string>()
    for (const tabs of Object.values(unifiedTabsByWorktree)) {
      for (const tab of tabs) {
        if (tab.contentType === 'terminal') {
          ids.add(tab.entityId)
        }
      }
    }
    return ids
  }, [unifiedTabsByWorktree])
  const selectedAutomationRunPageWorktree = selectedAutomationRunPage?.workspaceId
    ? (worktreeMap.get(selectedAutomationRunPage.workspaceId) ?? null)
    : null
  const selectedAutomationRunPageWorkspaceDisplay = selectedAutomationRunPage
    ? getAutomationRunWorkspaceDisplay({
        run: selectedAutomationRunPage,
        worktree: selectedAutomationRunPageWorktree
      })
    : null
  const selectedAutomationRunPageViewState = selectedAutomationRunPage
    ? getAutomationRunViewState({
        run: selectedAutomationRunPage,
        workspaceExists: Boolean(selectedAutomationRunPageWorktree),
        terminalTabExists: selectedAutomationRunPage.terminalSessionId
          ? activeTerminalTabIds.has(selectedAutomationRunPage.terminalSessionId)
          : false
      })
    : null
  const canRerunSelectedAutomationRunPage =
    selectedAutomationRunPage !== null &&
    canRerunAutomationRun({ automation: selected, run: selectedAutomationRunPage })
  const isSelectedAutomationRunPageRerunPending =
    selectedAutomationRunPage !== null && rerunRunIdsInFlight.has(selectedAutomationRunPage.id)
  const selectedRepo = selected ? (repoMap.get(selected.projectId) ?? null) : null
  const selectedWorktree =
    selected && selected.workspaceId ? (worktreeMap.get(selected.workspaceId) ?? null) : null
  const canSaveDraft =
    editingAutomationId === null ||
    !draftAtOpen ||
    JSON.stringify(draft) !== JSON.stringify(draftAtOpen)
  const selectedExternalSshSource =
    selectedExternal?.kind === 'source' && selectedExternal.manager.target.type === 'ssh'
      ? {
          manager: selectedExternal.manager,
          connectionId: selectedExternal.manager.target.connectionId,
          sourceKey: getExternalAutomationSourceKey(selectedExternal.manager)
        }
      : null
  const isSelectedExternalSshConnecting =
    selectedExternalSshSource !== null &&
    (connectingExternalSourceKey === selectedExternalSshSource.sourceKey ||
      isSshConnectionBusy(sshConnectionStates.get(selectedExternalSshSource.connectionId)?.status))

  useEffect(() => {
    if ((!selected || selectedExternal) && activePaneTab === 'runs') {
      setActivePaneTab('overview')
    }
  }, [activePaneTab, selected, selectedExternal])

  useEffect(() => {
    setSelectedExternalRunPage(null)
  }, [selectedExternalKey])

  useEffect(() => {
    setSelectedAutomationRunPageId(null)
  }, [selected?.id])

  const getDefaultTarget = useCallback(() => {
    const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null
    const activeRepo = activeWorktree ? (repoMap.get(activeWorktree.repoId) ?? null) : null
    const fallbackRepo = activeRepo ?? repos[0] ?? null
    const fallbackWorktrees = fallbackRepo ? (worktreesByRepo[fallbackRepo.id] ?? []) : []
    // Why: automation-created workspaces can be active; new automations should start from
    // the repo's stable main worktree unless the user explicitly chooses otherwise.
    const targetWorktree = getDefaultWorktree(fallbackWorktrees) ?? activeWorktree
    const targetProjectId = fallbackRepo?.id ?? targetWorktree?.repoId ?? ''
    return {
      projectId: targetProjectId,
      workspaceId: targetWorktree?.id ?? ''
    }
  }, [activeWorktreeId, repoMap, repos, worktreeMap, worktreesByRepo])

  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      const [nextAutomations, nextRuns, nextExternalManagers] = await Promise.all([
        window.api.automations.list(),
        window.api.automations.listRuns(),
        window.api.automations.listExternalManagers()
      ])
      const currentSelectedId = useAppStore.getState().selectedAutomationId
      const hasCurrentSelection = nextAutomations.some(
        (automation) => automation.id === currentSelectedId
      )
      const nextSelectedId = hasCurrentSelection
        ? currentSelectedId
        : (nextAutomations[0]?.id ?? null)
      const nextSelectedRuns = nextSelectedId
        ? await window.api.automations.listRuns({ automationId: nextSelectedId })
        : []
      setAutomations(nextAutomations)
      setRuns(nextRuns)
      setSelectedAutomationRuns({
        automationId: nextSelectedId,
        runs: nextSelectedRuns
      })
      setExternalManagers(nextExternalManagers)
      if (!hasCurrentSelection) {
        setSelectedId(nextAutomations[0]?.id ?? null)
      }
    } finally {
      setIsLoading(false)
    }
  }, [setSelectedId])

  const hydratePersistedUIState = useCallback(async (): Promise<void> => {
    useAppStore.getState().hydratePersistedUI(await window.api.ui.get())
  }, [])

  useEffect(() => {
    void fetchAllWorktrees()
    void refresh()
  }, [fetchAllWorktrees, refresh])

  useEffect(() => {
    const timer = window.setInterval(() => setRelativeNow(Date.now()), 60 * 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const automationId = selected?.id ?? null
    if (!automationId) {
      setSelectedAutomationRuns({ automationId: null, runs: [] })
      return
    }
    let cancelled = false
    void window.api.automations.listRuns({ automationId }).then((nextRuns) => {
      if (!cancelled) {
        setSelectedAutomationRuns({ automationId, runs: nextRuns })
      }
    })
    return () => {
      cancelled = true
    }
  }, [selected?.id, runs])

  useEffect(() => {
    const onAutomationsChanged = (): void => {
      void refresh()
    }
    window.addEventListener(AUTOMATIONS_CHANGED_EVENT, onAutomationsChanged)
    return () => window.removeEventListener(AUTOMATIONS_CHANGED_EVENT, onAutomationsChanged)
  }, [refresh])

  useEffect(() => {
    const onVisibilityOrFocus = (): void => {
      if (document.visibilityState === 'visible') {
        void refresh()
      }
    }
    window.addEventListener('focus', onVisibilityOrFocus)
    document.addEventListener('visibilitychange', onVisibilityOrFocus)
    return () => {
      window.removeEventListener('focus', onVisibilityOrFocus)
      document.removeEventListener('visibilitychange', onVisibilityOrFocus)
    }
  }, [refresh])

  useEffect(() => {
    const inFlight = completionInFlightRef.current
    const completedRuns = runs.filter((run) => {
      if (run.status !== 'dispatched' || !run.terminalSessionId) {
        return false
      }
      if (inFlight.has(run.id)) {
        return false
      }
      const dispatchedAt = run.dispatchedAt ?? null
      if (dispatchedAt === null) {
        return false
      }
      const paneKeyPrefix = `${run.terminalSessionId}:`
      const liveDone = Object.entries(agentStatusByPaneKey).some(
        ([paneKey, entry]) =>
          paneKey.startsWith(paneKeyPrefix) &&
          entry.state === 'done' &&
          entry.updatedAt >= dispatchedAt
      )
      if (liveDone) {
        return true
      }
      return Object.entries(retainedAgentsByPaneKey).some(
        ([paneKey, retained]) =>
          paneKey.startsWith(paneKeyPrefix) &&
          retained.entry.state === 'done' &&
          retained.entry.updatedAt >= dispatchedAt
      )
    })
    if (completedRuns.length === 0) {
      return
    }
    for (const run of completedRuns) {
      inFlight.add(run.id)
    }
    void Promise.all(
      completedRuns.map((run) =>
        window.api.automations.markDispatchResult({
          runId: run.id,
          status: 'completed',
          workspaceId: run.workspaceId,
          terminalSessionId: run.terminalSessionId,
          error: null
        })
      )
    )
      .then(() => refresh())
      .catch((error) => {
        console.error('[automations] failed to mark completed dispatch result:', error)
      })
      .finally(() => {
        for (const run of completedRuns) {
          inFlight.delete(run.id)
        }
      })
  }, [agentStatusByPaneKey, retainedAgentsByPaneKey, refresh, runs])

  useEffect(() => {
    if (!draft.projectId) {
      const target = getDefaultTarget()
      if (!target.projectId) {
        return
      }
      setDraft((current) => ({
        ...current,
        projectId: target.projectId,
        workspaceId: target.workspaceId
      }))
    }
  }, [draft.projectId, getDefaultTarget])

  useEffect(() => {
    if (!draft.projectId) {
      return
    }
    const available = worktreesByRepo[draft.projectId] ?? []
    const defaultWorktree = getDefaultWorktree(available)
    if (!draft.workspaceId && defaultWorktree) {
      setDraft((current) => ({ ...current, workspaceId: defaultWorktree.id }))
    }
  }, [draft.projectId, draft.workspaceId, worktreesByRepo])

  const applyTemplateToDraft = useCallback((template: AutomationTemplate): void => {
    setDraft((current) => ({
      ...current,
      name: template.name,
      prompt: template.prompt,
      preset: template.preset,
      time: template.time ?? current.time,
      dayOfWeek: template.dayOfWeek ?? current.dayOfWeek,
      customSchedule: '',
      agentId: template.agentId ?? current.agentId,
      missedRunGraceMinutes: template.missedRunGraceMinutes ?? current.missedRunGraceMinutes,
      scheduleWarning: null
    }))
  }, [])

  const handleCreateTargetChange = useCallback((target: AutomationCreateTarget): void => {
    setCreateTarget(target)
    if (target === 'hermes') {
      setDraft((current) => ({
        ...current,
        agentId: 'hermes',
        workspaceMode: 'existing',
        reuseSession: false
      }))
    }
  }, [])

  const openCreateDialog = (template?: AutomationTemplate): void => {
    editRequestRef.current += 1
    const target = getDefaultTarget()
    setEditingAutomationId(null)
    setEditingExternalTarget(null)
    setCreateTarget('orca')
    const baseDraft: AutomationDraft = {
      name: '',
      prompt: '',
      agentId: defaultAgent,
      projectId: target.projectId,
      workspaceMode: 'existing',
      workspaceId: target.workspaceId,
      baseBranch: '',
      reuseSession: false,
      preset: 'weekdays',
      time: DEFAULT_TIME,
      dayOfWeek: '1',
      customSchedule: '',
      missedRunGraceMinutes: '720',
      scheduleWarning: null
    }
    const nextDraft = template
      ? {
          ...baseDraft,
          name: template.name,
          prompt: template.prompt,
          preset: template.preset,
          time: template.time ?? baseDraft.time,
          dayOfWeek: template.dayOfWeek ?? baseDraft.dayOfWeek,
          customSchedule: '',
          agentId: template.agentId ?? baseDraft.agentId,
          missedRunGraceMinutes: template.missedRunGraceMinutes ?? baseDraft.missedRunGraceMinutes
        }
      : baseDraft
    setDraft(nextDraft)
    setDraftAtOpen(nextDraft)
    setCreateOpen(true)
  }

  const openEditDialog = async (automation: Automation): Promise<void> => {
    const requestId = (editRequestRef.current += 1)
    setEditingExternalTarget(null)
    setCreateTarget('orca')
    let latest = automation
    try {
      latest =
        (await window.api.automations.list()).find((entry) => entry.id === automation.id) ??
        automation
    } catch {
      latest = automation
    }
    if (requestId !== editRequestRef.current) {
      return
    }
    const schedule = tryParseAutomationRrule(latest.rrule)
    const hasCustomSchedule = !schedule && isValidAutomationSchedule(latest.rrule)
    setEditingAutomationId(latest.id)
    const nextDraft: AutomationDraft = {
      name: latest.name,
      prompt: latest.prompt,
      agentId: latest.agentId,
      projectId: latest.projectId,
      workspaceMode: latest.workspaceMode,
      workspaceId: latest.workspaceId ?? '',
      baseBranch: latest.baseBranch ?? '',
      reuseSession: latest.workspaceMode === 'existing' && latest.reuseSession,
      preset: schedule?.preset ?? (hasCustomSchedule ? 'custom' : 'weekdays'),
      time: schedule ? formatTimeInput(schedule.hour, schedule.minute) : DEFAULT_TIME,
      dayOfWeek: String(schedule?.dayOfWeek ?? 1),
      customSchedule: hasCustomSchedule ? latest.rrule : '',
      missedRunGraceMinutes: String(latest.missedRunGraceMinutes),
      scheduleWarning:
        schedule || hasCustomSchedule
          ? null
          : 'This automation has an unsupported saved schedule. Pick a supported schedule before saving changes.'
    }
    setDraft(nextDraft)
    setDraftAtOpen(nextDraft)
    setCreateOpen(true)
  }

  const openEditExternalDialog = (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob
  ): void => {
    editRequestRef.current += 1
    const rawSchedule = job.rawSchedule?.trim() ?? ''
    const hasCustomSchedule = isValidAutomationCronSchedule(rawSchedule)
    const targetWorktree =
      Object.values(worktreesByRepo)
        .flat()
        .find((worktree) => {
          const repo = repoMap.get(worktree.repoId)
          const repoTargetMatches =
            manager.target.type === 'local'
              ? !repo?.connectionId
              : repo?.connectionId === manager.target.connectionId
          return repoTargetMatches && job.workdir !== null && worktree.path === job.workdir
        }) ?? null
    const fallbackTarget = getDefaultTarget()
    const projectId = targetWorktree?.repoId ?? fallbackTarget.projectId
    const workspaceId = targetWorktree?.id ?? fallbackTarget.workspaceId
    const nextDraft: AutomationDraft = {
      name: job.name,
      prompt: job.prompt ?? job.promptPreview,
      agentId: 'hermes',
      projectId,
      workspaceMode: 'existing',
      workspaceId,
      baseBranch: '',
      reuseSession: false,
      preset: hasCustomSchedule ? 'custom' : 'weekdays',
      time: DEFAULT_TIME,
      dayOfWeek: '1',
      customSchedule: hasCustomSchedule ? rawSchedule : '',
      missedRunGraceMinutes: '720',
      scheduleWarning: hasCustomSchedule
        ? null
        : 'This Hermes automation has an unsupported saved schedule. Pick a supported schedule before saving changes.'
    }
    setEditingAutomationId(null)
    setEditingExternalTarget({ manager, job })
    setCreateTarget('hermes')
    setDraft(nextDraft)
    setDraftAtOpen(nextDraft)
    setCreateOpen(true)
  }

  const handleProjectChange = useCallback(
    (projectId: string): void => {
      const currentWorktrees = worktreesByRepo[projectId] ?? []
      const currentDefaultWorktree = getDefaultWorktree(currentWorktrees)
      setDraft((current) => ({
        ...current,
        projectId,
        workspaceId: currentDefaultWorktree?.id ?? '',
        baseBranch: ''
      }))

      void fetchWorktrees(projectId).then(() => {
        const latestWorktrees = useAppStore.getState().worktreesByRepo[projectId] ?? []
        const latestWorktree = getDefaultWorktree(latestWorktrees)
        if (!latestWorktree) {
          return
        }
        // Why: project worktrees may not be loaded when the repo picker changes.
        // Select after fetching so saving does not fail on an empty workspace id.
        setDraft((current) =>
          current.projectId === projectId && !current.workspaceId
            ? { ...current, workspaceId: latestWorktree.id }
            : current
        )
      })
    },
    [fetchWorktrees, worktreesByRepo]
  )

  const saveAutomation = async (): Promise<void> => {
    const { hour, minute } = parseDraftTime(draft.time)
    const isHermesSave =
      editingAutomationId === null && (createTarget === 'hermes' || editingExternalTarget !== null)
    if (
      !draft.projectId ||
      ((draft.workspaceMode === 'existing' || isHermesSave) && !draft.workspaceId) ||
      !draft.prompt.trim()
    ) {
      toast.error('Choose a run location and enter a prompt before saving.')
      return
    }
    if (draft.scheduleWarning) {
      toast.error('Pick a supported schedule before saving.')
      return
    }
    const validateAdvancedSchedule = isHermesSave
      ? isValidAutomationCronSchedule
      : isValidAutomationSchedule
    if (draft.preset === 'custom' && !validateAdvancedSchedule(draft.customSchedule)) {
      toast.error('Enter a valid advanced schedule before saving.')
      return
    }
    if (
      editingAutomationId === null &&
      !isHermesSave &&
      !isTuiAgentEnabled(draft.agentId, settings?.disabledTuiAgents)
    ) {
      toast.error('Choose an enabled agent before saving.')
      return
    }
    setIsSaving(true)
    try {
      const selectedWorkspaceExists =
        draft.workspaceMode !== 'existing' ||
        worktrees.some((worktree) => worktree.id === draft.workspaceId)
      if (!selectedWorkspaceExists) {
        toast.error('Choose an available workspace before saving.')
        return
      }
      if (isHermesSave) {
        const repo = repoMap.get(draft.projectId)
        const selectedWorktree = worktreeMap.get(draft.workspaceId) ?? null
        if (!repo || !selectedWorktree) {
          toast.error('Choose an available workspace before saving.')
          return
        }
        const target =
          editingExternalTarget?.manager.target ??
          (repo.connectionId
            ? { type: 'ssh' as const, connectionId: repo.connectionId }
            : { type: 'local' as const })
        const repoTargetMatches =
          target.type === 'local' ? !repo.connectionId : repo.connectionId === target.connectionId
        if (!repoTargetMatches) {
          toast.error('Choose a workspace on the same host as this Hermes automation.')
          return
        }
        const schedule = buildHermesCronSchedule(draft)
        const managerId =
          editingExternalTarget?.manager.id ??
          (target.type === 'ssh' ? `hermes:ssh:${target.connectionId}` : 'hermes:local')
        const input = {
          managerId,
          provider: 'hermes' as const,
          target,
          name: draft.name,
          prompt: draft.prompt,
          schedule,
          workdir: selectedWorktree.path
        }
        await (editingExternalTarget
          ? window.api.automations.updateExternal({
              ...input,
              jobId: editingExternalTarget.job.id
            })
          : window.api.automations.createExternal(input))
        if (!editingExternalTarget) {
          useAppStore.getState().recordFeatureInteraction('automation-created')
        }
        await refresh()
        setCreateOpen(false)
        setEditingExternalTarget(null)
        setSelectedExternalKey(
          editingExternalTarget
            ? getExternalAutomationKey(editingExternalTarget.manager, editingExternalTarget.job)
            : null
        )
        toast.success(
          editingExternalTarget ? 'Hermes automation updated.' : 'Hermes automation created.'
        )
        return
      }
      const now = Date.now()
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const rrule =
        draft.preset === 'custom'
          ? draft.customSchedule.trim()
          : buildAutomationRrule({
              preset: draft.preset,
              hour,
              minute,
              dayOfWeek: Number(draft.dayOfWeek)
            })
      const rawMissedRunGraceMinutes = Number(draft.missedRunGraceMinutes)
      const missedRunGraceMinutes = Number.isFinite(rawMissedRunGraceMinutes)
        ? Math.max(0, rawMissedRunGraceMinutes)
        : 720
      let currentAutomation = editingAutomationId
        ? (automations.find((automation) => automation.id === editingAutomationId) ?? null)
        : null
      if (editingAutomationId) {
        try {
          currentAutomation =
            (await window.api.automations.list()).find(
              (automation) => automation.id === editingAutomationId
            ) ?? currentAutomation
        } catch {
          // Keep the in-memory automation as a fallback if the refresh fails.
        }
      }
      const updates: AutomationUpdateInput = {
        name: draft.name,
        prompt: draft.prompt,
        agentId: draft.agentId,
        projectId: draft.projectId,
        workspaceMode: draft.workspaceMode,
        workspaceId: draft.workspaceId,
        baseBranch: draft.baseBranch.trim() || null,
        reuseSession: draft.workspaceMode === 'existing' && draft.reuseSession,
        timezone,
        missedRunGraceMinutes
      }
      if (!currentAutomation || currentAutomation.rrule !== rrule) {
        // Why: non-schedule edits should not reset dtstart or move nextRunAt.
        updates.rrule = rrule
        updates.dtstart = now
      }
      const automation = editingAutomationId
        ? await window.api.automations.update({
            id: editingAutomationId,
            updates
          })
        : await window.api.automations.create({
            name: draft.name,
            prompt: draft.prompt,
            agentId: draft.agentId,
            projectId: draft.projectId,
            workspaceMode: draft.workspaceMode,
            workspaceId: draft.workspaceId,
            baseBranch: draft.baseBranch.trim() || null,
            reuseSession: draft.workspaceMode === 'existing' && draft.reuseSession,
            timezone,
            rrule,
            dtstart: now,
            missedRunGraceMinutes
          })
      if (!editingAutomationId) {
        await hydratePersistedUIState()
      }
      setAutomations((current) => {
        const next = current.filter((entry) => entry.id !== automation.id)
        return [...next, automation].sort((left, right) => left.name.localeCompare(right.name))
      })
      setDraft((current) => ({ ...current, name: '', prompt: '' }))
      await refresh()
      setSelectedId(automation.id)
      setCreateOpen(false)
      toast.success(editingAutomationId ? 'Automation updated.' : 'Automation saved.')
    } catch (error) {
      if (isHermesSave) {
        await refresh().catch(() => undefined)
      }
      toast.error(error instanceof Error ? error.message : 'Failed to save automation.')
    } finally {
      setIsSaving(false)
    }
  }

  const toggleAutomation = async (automation: Automation): Promise<void> => {
    await window.api.automations.update({
      id: automation.id,
      updates: { enabled: !automation.enabled }
    })
    await refresh()
  }

  const deleteAutomation = async (automation: Automation): Promise<void> => {
    await window.api.automations.delete({ id: automation.id })
    if (useAppStore.getState().selectedAutomationId === automation.id) {
      setSelectedId(null)
    }
    await refresh()
  }

  const persistDeleteAutomationPreference = (): void => {
    void updateSettings({ skipDeleteAutomationConfirm: true })
    toast.success("We'll skip this confirmation next time.", {
      description: 'You can change this in Settings.',
      duration: 8000,
      action: {
        label: 'Open Settings',
        onClick: () => {
          openSettingsPage()
          openSettingsTarget({
            pane: 'general',
            repoId: null,
            sectionId: 'general-skip-delete-automation-confirm'
          })
        }
      }
    })
  }

  const requestDeleteAutomation = (automation: Automation): void => {
    if (settings?.skipDeleteAutomationConfirm) {
      void deleteAutomation(automation)
      return
    }
    setDontAskDeleteAgain(false)
    setDeleteTarget(automation)
  }

  const confirmDeleteAutomation = async (): Promise<void> => {
    if (!deleteTarget) {
      return
    }
    if (dontAskDeleteAgain) {
      persistDeleteAutomationPreference()
    }
    const target = deleteTarget
    setDeleteTarget(null)
    setDontAskDeleteAgain(false)
    await deleteAutomation(target)
  }

  const runNow = async (automation: Automation): Promise<void> => {
    await window.api.automations.runNow({ id: automation.id })
    await hydratePersistedUIState()
    await refresh()
    toast.message('Automation run queued.')
  }

  const rerunAutomationRun = async (automation: Automation, run: AutomationRun): Promise<void> => {
    const automationId = automation.id
    const runId = run.id
    if (rerunRunIdsInFlightRef.current.has(runId)) {
      return
    }
    const pendingStartedAt = Date.now()
    rerunRunIdsInFlightRef.current.add(runId)
    setRerunRunIdsInFlight(new Set(rerunRunIdsInFlightRef.current))
    try {
      await window.api.automations.runNow({ id: automationId })
      await hydratePersistedUIState()
      await refresh()
      toast.message('Automation run queued.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to rerun automation.')
      await refresh()
    } finally {
      // Why: fast skipped/failed reruns can settle before users or validation can see the guard.
      await waitForAutomationRerunPendingVisibility(pendingStartedAt)
      rerunRunIdsInFlightRef.current.delete(runId)
      setRerunRunIdsInFlight(new Set(rerunRunIdsInFlightRef.current))
    }
  }

  const runExternalAction = async (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction
  ): Promise<void> => {
    const key = `${manager.id}:${job.id}:${action}`
    setExternalActionKey(key)
    try {
      await window.api.automations.runExternalAction({
        managerId: manager.id,
        provider: manager.provider,
        target: manager.target,
        jobId: job.id,
        action
      })
      if (action === 'run') {
        useAppStore.getState().recordFeatureInteraction('automation-run')
      }
      await refresh()
      toast.success(
        action === 'delete'
          ? 'External automation deleted.'
          : action === 'run'
            ? 'External automation queued.'
            : action === 'pause'
              ? 'External automation paused.'
              : 'External automation resumed.'
      )
    } catch (error) {
      await refresh().catch(() => undefined)
      toast.error(error instanceof Error ? error.message : 'External automation action failed.')
    } finally {
      setExternalActionKey(null)
    }
  }

  const fetchExternalAutomationRuns = useCallback<FetchExternalAutomationRuns>(
    async ({ manager, job, page, pageSize }) => {
      const fallbackRunsPage = {
        runs: job.runs.slice(page * pageSize, page * pageSize + pageSize),
        totalCount: job.runCount
      }
      const listExternalRuns = (
        window.api.automations as Partial<Pick<typeof window.api.automations, 'listExternalRuns'>>
      ).listExternalRuns
      if (typeof listExternalRuns !== 'function') {
        return fallbackRunsPage
      }
      try {
        const result = await listExternalRuns({
          managerId: manager.id,
          provider: manager.provider,
          target: manager.target,
          jobId: job.id,
          page: page + 1,
          pageSize
        })
        return {
          runs: result.runs,
          totalCount: result.total
        }
      } catch (error) {
        if (isMissingExternalRunsApiError(error)) {
          return fallbackRunsPage
        }
        throw error
      }
    },
    []
  )

  const openExternalRunPage = (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    run: ExternalAutomationRun
  ): void => {
    setSelectedExternalRunPage({ manager, job, run })
  }

  const openAutomationRunPage = (run: AutomationRun): void => {
    setSelectedAutomationRunPageId(run.id)
  }

  const requestExternalAction = (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction
  ): void => {
    if (action === 'delete') {
      setExternalDeleteTarget({ manager, job })
      return
    }
    void runExternalAction(manager, job, action)
  }

  const confirmDeleteExternalAutomation = async (): Promise<void> => {
    if (!externalDeleteTarget) {
      return
    }
    const target = externalDeleteTarget
    setExternalDeleteTarget(null)
    await runExternalAction(target.manager, target.job, 'delete')
  }

  const connectExternalAutomationSource = async (
    manager: ExternalAutomationManager
  ): Promise<void> => {
    if (manager.target.type !== 'ssh') {
      return
    }
    const sourceKey = getExternalAutomationSourceKey(manager)
    setConnectingExternalSourceKey(sourceKey)
    try {
      const state = await window.api.ssh.connect({ targetId: manager.target.connectionId })
      if (!state || state.status !== 'connected') {
        toast.error(state?.error ?? 'SSH connections are unavailable in this client.')
        return
      }
      await refresh()
      toast.success('SSH connected.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'SSH connection failed.')
    } finally {
      setConnectingExternalSourceKey(null)
    }
  }

  const openRunWorkspace = (run: AutomationRun): void => {
    const runWorktree = run.workspaceId ? (worktreeMap.get(run.workspaceId) ?? null) : null
    const store = useAppStore.getState()
    const runViewState = getAutomationRunViewState({
      run,
      workspaceExists: Boolean(runWorktree),
      terminalTabExists: run.terminalSessionId
        ? Boolean(store.getTab(run.terminalSessionId))
        : false
    })
    if (!run.workspaceId || !runWorktree || !runViewState.canOpen) {
      toast.error(runViewState.statusLabel)
      return
    }
    const terminalTabExistsBeforeActivation = run.terminalSessionId
      ? Boolean(store.getTab(run.terminalSessionId))
      : false
    if (run.terminalSessionId) {
      if (terminalTabExistsBeforeActivation && activateAndRevealWorktree(run.workspaceId)) {
        store.setActiveTab(run.terminalSessionId)
        store.setActiveTabType('terminal')
        return
      }
    }
    if (!activateAndRevealWorktree(run.workspaceId)) {
      toast.error('Workspace is not available.')
      return
    }
    // Why: activation can create a fresh terminal for an empty workspace; tell
    // users when that is not the original automation run session.
    toast.message(runViewState.statusLabel)
  }

  useEffect(() => {
    if (createOpen || deleteTarget || externalDeleteTarget) {
      return
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }

      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      // Why: match Tasks page behavior: Esc first exits field focus, then exits
      // the page once focus is back on page chrome.
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      ) {
        event.preventDefault()
        target.blur()
        return
      }

      event.preventDefault()
      closeAutomationsPage()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [closeAutomationsPage, createOpen, deleteTarget, externalDeleteTarget])

  return (
    <main className="relative flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between px-5 pb-3 pt-1.5 md:px-8">
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 rounded-full"
                onClick={closeAutomationsPage}
                aria-label="Close automations"
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Close · Esc
            </TooltipContent>
          </Tooltip>
          <div className="mx-1 h-5 w-px bg-border/50" aria-hidden />
          <CalendarClock className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold">Automations</h1>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Add automation"
                onClick={() => openCreateDialog()}
                className="border border-border/50 bg-transparent hover:bg-muted/50"
              >
                <Plus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Add automation
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh automations"
                onClick={refresh}
                disabled={isLoading}
                className="border border-border/50 bg-transparent hover:bg-muted/50"
              >
                <RefreshCw className={cn('size-4', isLoading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Refresh automations
            </TooltipContent>
          </Tooltip>
        </div>
      </header>

      <AutomationEditorDialog
        open={createOpen}
        isEditing={editingAutomationId !== null}
        isSaving={isSaving}
        canSave={canSaveDraft}
        isEditingExternal={editingExternalTarget !== null}
        createTarget={createTarget}
        repos={repos}
        repoMap={repoMap}
        worktrees={worktrees}
        settings={settings}
        draft={draft}
        onProjectChange={handleProjectChange}
        onCreateTargetChange={handleCreateTargetChange}
        onOpenChange={setCreateOpen}
        onDraftChange={setDraft}
        onApplyTemplate={applyTemplateToDraft}
        onSave={() => void saveAutomation()}
      />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (open) {
            return
          }
          setDeleteTarget(null)
          setDontAskDeleteAgain(false)
        }}
      >
        <DialogContent
          className="max-w-md"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            deleteConfirmButtonRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">Delete Automation</DialogTitle>
            <DialogDescription className="text-xs">
              Delete{' '}
              <span className="break-all font-medium text-foreground">{deleteTarget?.name}</span>{' '}
              and its run history. Workspaces created by previous runs are not deleted.
            </DialogDescription>
          </DialogHeader>
          {deleteTarget ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="break-all font-medium text-foreground">{deleteTarget.name}</div>
              <div className="mt-1 text-muted-foreground">
                {deleteTarget.workspaceMode === 'new_per_run'
                  ? 'New workspace each run'
                  : 'Selected workspace'}
              </div>
            </div>
          ) : null}
          <button
            type="button"
            role="checkbox"
            aria-checked={dontAskDeleteAgain}
            onClick={() => setDontAskDeleteAgain((prev) => !prev)}
            className="flex items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={`flex size-4 items-center justify-center rounded-sm border transition-colors ${
                dontAskDeleteAgain
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-muted-foreground bg-transparent'
              }`}
            >
              {dontAskDeleteAgain ? <Check className="size-3" strokeWidth={3} /> : null}
            </span>
            Don&apos;t ask again
          </button>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteTarget(null)
                setDontAskDeleteAgain(false)
              }}
            >
              Cancel
            </Button>
            <Button
              ref={deleteConfirmButtonRef}
              variant="destructive"
              onClick={() => void confirmDeleteAutomation()}
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={externalDeleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setExternalDeleteTarget(null)
          }
        }}
      >
        <DialogContent
          className="max-w-md"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            deleteConfirmButtonRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">Delete External Automation</DialogTitle>
            <DialogDescription className="text-xs">
              Delete{' '}
              <span className="break-all font-medium text-foreground">
                {externalDeleteTarget?.job.name}
              </span>{' '}
              from{' '}
              {externalDeleteTarget
                ? getExternalProviderLabel(externalDeleteTarget.manager)
                : 'external source'}{' '}
              on {externalDeleteTarget?.manager.targetLabel}.
            </DialogDescription>
          </DialogHeader>
          {externalDeleteTarget ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="break-all font-medium text-foreground">
                {externalDeleteTarget.job.name}
              </div>
              <div className="mt-1 text-muted-foreground">
                {
                  getExternalAutomationScheduleDisplay(
                    externalDeleteTarget.manager,
                    externalDeleteTarget.job
                  ).label
                }
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setExternalDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              ref={deleteConfirmButtonRef}
              variant="destructive"
              onClick={() => void confirmDeleteExternalAutomation()}
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,360px)_1fr] overflow-hidden border-t border-border/50">
        <section className="flex min-h-0 flex-col border-r border-border/50 bg-muted/20">
          <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto p-2">
            {automations.length + externalAutomationEntries.length > 0 ? (
              <div className="grid grid-cols-[1fr_auto] gap-2 px-2 pb-2 text-[11px] font-medium uppercase text-muted-foreground">
                <span>Automation</span>
                <span>Next</span>
              </div>
            ) : null}
            {automations.map((automation) => {
              const automationRepo = repoMap.get(automation.projectId)
              const automationWorktree = automation.workspaceId
                ? worktreeMap.get(automation.workspaceId)
                : null
              const workspaceLabel =
                automation.workspaceMode === 'new_per_run'
                  ? `Create from ${automation.baseBranch ?? automationRepo?.worktreeBaseRef ?? 'project default'}`
                  : (automationWorktree?.displayName ?? 'Missing workspace')
              const usageSummary = summarizeAutomationRunUsage(
                runs.filter((run) => run.automationId === automation.id)
              )
              const usageText =
                usageSummary.knownRuns > 0
                  ? `${formatAutomationCost(
                      usageSummary.estimatedCostUsd
                    )} est. · ${formatAutomationTokens(usageSummary.totalTokens)} tokens`
                  : usageSummary.unavailableRuns > 0
                    ? 'Usage unavailable'
                    : 'No run usage yet'
              const nextRunLabel = automation.enabled
                ? formatAutomationDateTimeWithRelative(automation.nextRunAt, relativeNow)
                : 'Paused'
              const scheduleLabel = formatAutomationSchedule(automation.rrule)
              return (
                <ContextMenu key={automation.id}>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedExternalKey(null)
                        setSelectedId(automation.id)
                      }}
                      className={cn(
                        'mb-1 grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                        selectedExternal === null && selected?.id === automation.id
                          ? 'border-foreground/30 bg-muted/70 text-foreground shadow-sm'
                          : 'border-transparent hover:bg-muted/50'
                      )}
                    >
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className={cn(
                              'size-2 rounded-full',
                              automation.enabled ? 'bg-foreground' : 'bg-muted-foreground/40'
                            )}
                          />
                          <span className="truncate font-medium">{automation.name}</span>
                        </span>
                        <span className="mt-1 block truncate text-xs font-medium text-foreground/80">
                          {scheduleLabel}
                        </span>
                        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                          {automationRepo ? (
                            <RepoBadgeLabel
                              name={automationRepo.displayName}
                              color={automationRepo.badgeColor}
                              badgeClassName="size-1.5"
                            />
                          ) : (
                            <span>Unknown project</span>
                          )}
                          <span className="shrink-0">/</span>
                          <span className="truncate">{workspaceLabel}</span>
                          <span className="shrink-0">·</span>
                          <span className="truncate">{getAgentLabel(automation.agentId)}</span>
                        </span>
                        <span className="mt-1 block truncate text-xs text-muted-foreground">
                          {usageText}
                        </span>
                      </span>
                      <span className="flex max-w-28 flex-col items-end gap-1 text-right text-xs text-muted-foreground">
                        <Clock className="size-3.5" />
                        <span className="line-clamp-2">{nextRunLabel}</span>
                      </span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuItem onSelect={() => void runNow(automation)}>
                      <Play className="size-3.5" />
                      Run Now
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void openEditDialog(automation)}>
                      <Pencil className="size-3.5" />
                      Edit
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void toggleAutomation(automation)}>
                      {automation.enabled ? (
                        <Pause className="size-3.5" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                      {automation.enabled ? 'Pause' : 'Resume'}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      onSelect={() => requestDeleteAutomation(automation)}
                    >
                      <Trash2 className="size-3.5" />
                      Delete
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )
            })}
            {externalAutomationEntries.map((entry) => {
              const providerLabel = getExternalProviderLabel(entry.manager)
              const targetKindLabel = getExternalTargetKindLabel(entry.manager)
              if (entry.kind === 'source') {
                const sourceStatus =
                  entry.manager.target.type === 'ssh' ? 'Connect to load jobs' : 'Unavailable'
                const sourceSummary =
                  entry.manager.error ??
                  `${providerLabel} source unavailable until ${targetKindLabel.toLowerCase()} connects.`
                return (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => {
                      setSelectedExternalKey(entry.key)
                      setActivePaneTab('overview')
                    }}
                    className={cn(
                      'mb-1 grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                      selectedExternal?.key === entry.key
                        ? 'border-foreground/30 bg-muted/70 text-foreground shadow-sm'
                        : 'border-transparent hover:bg-muted/50'
                    )}
                  >
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="size-2 rounded-full bg-muted-foreground/40" />
                        <span className="truncate font-medium">{entry.manager.targetLabel}</span>
                      </span>
                      <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <span>{providerLabel} source</span>
                        <span className="shrink-0">/</span>
                        <span className="truncate">{targetKindLabel}</span>
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {sourceSummary}
                      </span>
                    </span>
                    <span className="flex max-w-28 flex-col items-end gap-1 text-right text-xs text-muted-foreground">
                      <Clock className="size-3.5" />
                      <span className="line-clamp-2">{sourceStatus}</span>
                    </span>
                  </button>
                )
              }
              const nextRunLabel = entry.job.enabled
                ? formatExternalDate(entry.job.nextRunAt, relativeNow)
                : 'Paused'
              const actionDisabled = !entry.manager.canManage || externalActionKey !== null
              const scheduleDisplay = getExternalAutomationScheduleDisplay(entry.manager, entry.job)
              return (
                <ContextMenu key={entry.key}>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedExternalKey(entry.key)
                        setActivePaneTab('overview')
                      }}
                      className={cn(
                        'mb-1 grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                        selectedExternal?.key === entry.key
                          ? 'border-foreground/30 bg-muted/70 text-foreground shadow-sm'
                          : 'border-transparent hover:bg-muted/50'
                      )}
                    >
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className={cn(
                              'size-2 rounded-full',
                              entry.job.enabled ? 'bg-foreground' : 'bg-muted-foreground/40'
                            )}
                          />
                          <span className="truncate font-medium">{entry.job.name}</span>
                        </span>
                        <span className="mt-1 block truncate text-xs font-medium text-foreground/80">
                          {scheduleDisplay.label}
                        </span>
                        <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                          <span className="truncate">
                            {providerLabel} / {entry.manager.targetLabel}
                          </span>
                          <span className="shrink-0">·</span>
                          <span className="truncate">
                            {entry.manager.provider === 'hermes'
                              ? `${entry.job.runCount} ${entry.job.runCount === 1 ? 'run' : 'runs'}`
                              : entry.manager.canManage
                                ? 'Manageable'
                                : 'Read-only'}
                          </span>
                        </span>
                      </span>
                      <span className="flex max-w-28 flex-col items-end gap-1 text-right text-xs text-muted-foreground">
                        <Clock className="size-3.5" />
                        <span className="line-clamp-2">{nextRunLabel}</span>
                      </span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuItem
                      disabled={actionDisabled}
                      onSelect={() => requestExternalAction(entry.manager, entry.job, 'run')}
                    >
                      <Play className="size-3.5" />
                      Run Now
                    </ContextMenuItem>
                    {entry.manager.provider === 'hermes' ? (
                      <ContextMenuItem
                        disabled={!entry.manager.canManage || externalActionKey !== null}
                        onSelect={() => openEditExternalDialog(entry.manager, entry.job)}
                      >
                        <Pencil className="size-3.5" />
                        Edit
                      </ContextMenuItem>
                    ) : null}
                    <ContextMenuItem
                      disabled={actionDisabled}
                      onSelect={() =>
                        requestExternalAction(
                          entry.manager,
                          entry.job,
                          entry.job.enabled ? 'pause' : 'resume'
                        )
                      }
                    >
                      {entry.job.enabled ? (
                        <Pause className="size-3.5" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                      {entry.job.enabled ? 'Pause' : 'Resume'}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      disabled={actionDisabled}
                      onSelect={() => requestExternalAction(entry.manager, entry.job, 'delete')}
                    >
                      <Trash2 className="size-3.5" />
                      Delete
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )
            })}
            {automations.length === 0 && externalAutomationEntries.length === 0 ? (
              <div className="grid gap-2 p-2">
                <div className="px-1 pb-1 text-sm font-medium">Start from a template</div>
                {AUTOMATION_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => openCreateDialog(template)}
                    className="rounded-md border border-border/70 bg-background px-3 py-2 text-left shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <div className="text-[11px] font-medium uppercase text-muted-foreground">
                      {template.category}
                    </div>
                    <div className="mt-1 text-sm font-medium">{template.label}</div>
                    <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {template.description}
                    </div>
                  </button>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  className="mt-1 w-full justify-start"
                  onClick={() => openCreateDialog()}
                >
                  <Plus className="size-4" />
                  Add new
                </Button>
              </div>
            ) : null}
          </div>
        </section>

        <section className="flex min-h-0 flex-col overflow-hidden">
          {selectedExternal ? (
            <div className="scrollbar-sleek min-h-0 overflow-auto p-5">
              {selectedExternalRunPage ? (
                <AutomationRunPageFrame
                  title={selectedExternalRunPage.job.name}
                  breadcrumbs={[
                    formatExternalDate(selectedExternalRunPage.run.runAt, relativeNow),
                    getExternalProviderLabel(selectedExternalRunPage.manager),
                    selectedExternalRunPage.manager.targetLabel
                  ]}
                  detail={selectedExternalRunPage.run.outputPath}
                  statusLabel={getExternalRunStatusLabel(selectedExternalRunPage.run)}
                  statusVariant={getExternalRunStatusVariant(selectedExternalRunPage.run)}
                  onBack={() => setSelectedExternalRunPage(null)}
                >
                  <HermesCronOutputView
                    content={getExternalRunContent(selectedExternalRunPage.run)}
                  />
                </AutomationRunPageFrame>
              ) : selectedExternal.kind === 'job' ? (
                <ExternalAutomationManagers
                  managers={[
                    {
                      ...selectedExternal.manager,
                      jobs: [selectedExternal.job]
                    }
                  ]}
                  now={relativeNow}
                  runningActionKey={externalActionKey}
                  onAction={requestExternalAction}
                  onFetchRuns={fetchExternalAutomationRuns}
                  onOpenRun={openExternalRunPage}
                  onEdit={openEditExternalDialog}
                />
              ) : (
                <div className="rounded-md border border-border/50 bg-muted/20 shadow-sm">
                  <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {selectedExternal.manager.targetLabel}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {getExternalProviderLabel(selectedExternal.manager)} source unavailable
                        {selectedExternal.manager.error
                          ? ` - ${selectedExternal.manager.error}`
                          : null}
                      </div>
                    </div>
                    {selectedExternalSshSource ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isSelectedExternalSshConnecting}
                        onClick={() =>
                          void connectExternalAutomationSource(selectedExternalSshSource.manager)
                        }
                      >
                        {isSelectedExternalSshConnecting ? (
                          <RefreshCw className="size-3.5 animate-spin" />
                        ) : null}
                        {isSelectedExternalSshConnecting ? 'Connecting...' : 'Connect SSH'}
                      </Button>
                    ) : null}
                  </div>
                  <div className="px-3 py-6 text-sm text-muted-foreground">
                    Connect this source to check for Hermes automations in the remote profile.
                  </div>
                </div>
              )}
            </div>
          ) : (
            <Tabs
              value={activePaneTab}
              onValueChange={(value) => setActivePaneTab(value as AutomationPaneTab)}
              className="min-h-0 flex-1 gap-0"
            >
              <div className="flex shrink-0 items-center justify-between border-b border-border/50 px-5 py-2">
                <TabsList variant="line" className="h-8">
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="runs" disabled={!selected}>
                    Runs
                    <span className="text-xs text-muted-foreground">{selectedRuns.length}</span>
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="overview" className="scrollbar-sleek min-h-0 overflow-auto p-5">
                <AutomationDetail
                  automation={selected}
                  runs={selectedRuns}
                  projectName={selectedRepo?.displayName ?? 'Unknown project'}
                  projectDefaultBaseRef={selectedRepo?.worktreeBaseRef ?? null}
                  workspaceName={
                    selected?.workspaceMode === 'new_per_run'
                      ? 'New workspace each run'
                      : (selectedWorktree?.displayName ?? 'Missing workspace')
                  }
                  now={relativeNow}
                  onRunNow={(automation) => void runNow(automation)}
                  onEdit={(automation) => void openEditDialog(automation)}
                  onToggle={(automation) => void toggleAutomation(automation)}
                  onDelete={requestDeleteAutomation}
                />
              </TabsContent>

              <TabsContent value="runs" className="scrollbar-sleek min-h-0 overflow-auto p-5">
                {selectedAutomationRunPage ? (
                  <AutomationRunPageFrame
                    title={selected?.name ?? selectedAutomationRunPage.title}
                    breadcrumbs={[
                      formatAutomationDateTimeWithRelative(
                        selectedAutomationRunPage.scheduledFor,
                        relativeNow
                      ),
                      'Orca',
                      selectedAutomationRunPageWorkspaceDisplay?.detailLabel ?? 'No workspace'
                    ]}
                    detail={
                      selectedAutomationRunPage.outputSnapshot?.truncated
                        ? 'Latest saved output'
                        : null
                    }
                    statusLabel={getAutomationRunStatusLabel(selectedAutomationRunPage.status)}
                    statusVariant={getAutomationRunStatusVariant(selectedAutomationRunPage.status)}
                    actions={
                      <>
                        {canRerunSelectedAutomationRunPage && selected ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isSelectedAutomationRunPageRerunPending}
                            onClick={() =>
                              void rerunAutomationRun(selected, selectedAutomationRunPage)
                            }
                          >
                            <RefreshCw
                              className={cn(
                                'size-3.5',
                                isSelectedAutomationRunPageRerunPending && 'animate-spin'
                              )}
                            />
                            Rerun
                          </Button>
                        ) : null}
                        {selectedAutomationRunPageViewState ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!selectedAutomationRunPageViewState.canOpen}
                            onClick={() => openRunWorkspace(selectedAutomationRunPage)}
                          >
                            <Eye className="size-3.5" />
                            {selectedAutomationRunPageViewState.actionLabel}
                          </Button>
                        ) : null}
                      </>
                    }
                    onBack={() => setSelectedAutomationRunPageId(null)}
                  >
                    <CommentMarkdown
                      variant="document"
                      content={getAutomationRunContent(selectedAutomationRunPage)}
                      className="text-sm leading-relaxed text-foreground"
                    />
                  </AutomationRunPageFrame>
                ) : selected ? (
                  <AutomationRunHistory
                    runs={selectedRuns}
                    automationId={selected.id}
                    worktreeMap={worktreeMap}
                    onOpenRun={openAutomationRunPage}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    Select an automation to view runs.
                  </div>
                )}
              </TabsContent>
            </Tabs>
          )}
        </section>
      </div>
    </main>
  )
}
