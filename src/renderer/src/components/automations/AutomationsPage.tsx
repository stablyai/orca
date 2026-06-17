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
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { cn } from '@/lib/utils'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useRepoMap, useWorktreeMap } from '@/store/selectors'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type {
  Automation,
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager,
  ExternalAutomationRun,
  AutomationPrecheck,
  AutomationRun,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import { getAutomationRunRepoId } from '../../../../shared/automation-run-identity'
import {
  getLocalExecutionHostLabel,
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { PreflightStatus } from '../../../../preload/api-types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { Repo, Worktree } from '../../../../shared/types'
import { getWorktreePathBasenameFromId } from '../../../../shared/worktree-id'
import {
  buildAutomationCronSchedule,
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
import { getAutomationTemplates, type AutomationTemplate } from './automation-templates'
import { getAutomationTargetAvailability } from './automation-target-availability'
import { buildAutomationRunContextForRepo } from './automation-run-context'
import {
  getRepoBackedProviderAvailability,
  type RuntimeProviderPreflightStatus
} from '../task-source-provider-availability'
import type { TaskSourceHostAvailability } from '../task-source-context-summary'
import {
  getExternalAutomationActionDisabledMessage,
  getExternalAutomationSourceAvailability,
  isSshConnectionBusy
} from './external-automation-source-availability'
import {
  createAutomationForTarget,
  deleteAutomationForTarget,
  getAutomationListTarget,
  listAutomationRunsForTarget,
  listAutomationsForTarget,
  runAutomationNowForTarget,
  updateAutomationForTarget
} from './automation-host-client'
import { getExternalAutomationScheduleDisplay } from './external-automation-schedule-display'
import { ExternalAutomationManagers } from './ExternalAutomationManagers'
import type { FetchExternalAutomationRuns } from './ExternalAutomationRunTable'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { translate } from '@/i18n/i18n'

const AGENTS = getAgentCatalog().map((agent) => agent.id)
const DEFAULT_TIME = '09:00'
const AUTOMATIONS_CHANGED_EVENT = 'orca:automations-changed'
type AutomationPaneTab = 'overview' | 'runs'
type RepoBackedAutomationSourceContext = TaskSourceContext & { provider: 'github' | 'gitlab' }

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

function getRepoBackedAutomationSourceContext(
  automation: Automation
): RepoBackedAutomationSourceContext | null {
  const context = automation.sourceContext
  return context?.provider === 'github' || context?.provider === 'gitlab'
    ? (context as RepoBackedAutomationSourceContext)
    : null
}

function getRuntimeSourceHostAvailability(
  context: TaskSourceContext,
  runtimeStatusByEnvironmentId: ReadonlyMap<
    string,
    { status: RuntimeStatus | null; checkedAt: number }
  >
): TaskSourceHostAvailability | null {
  const parsed = parseExecutionHostId(context.hostId)
  if (parsed?.kind !== 'runtime') {
    return null
  }
  const entry = runtimeStatusByEnvironmentId.get(parsed.environmentId)
  if (!entry) {
    return { hostId: context.hostId, reason: 'checking-task-source-capability' }
  }
  if (!entry.status) {
    return { hostId: context.hostId, health: 'disconnected' }
  }
  if (entry.status.graphStatus !== 'ready') {
    return { hostId: context.hostId, health: 'connecting' }
  }
  const capabilities = entry.status.capabilities
  if (!capabilities) {
    return { hostId: context.hostId, reason: 'checking-task-source-capability' }
  }
  if (!capabilities.includes(TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY)) {
    return { hostId: context.hostId, reason: 'missing-task-source-capability' }
  }
  return null
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

function buildDraftPrecheck(draft: AutomationDraft): AutomationPrecheck | null {
  const command = draft.precheckCommand.trim()
  if (!command) {
    return null
  }
  const rawTimeout = Number(draft.precheckTimeoutSeconds)
  return {
    command,
    timeoutSeconds: Number.isFinite(rawTimeout) ? rawTimeout : 60
  }
}

function buildHermesCronSchedule(draft: AutomationDraft): string {
  if (draft.preset === 'custom') {
    return draft.customSchedule.trim()
  }
  const { hour, minute } = parseDraftTime(draft.time)
  return buildAutomationCronSchedule({
    preset: draft.preset,
    hour,
    minute,
    dayOfWeek: Number(draft.dayOfWeek)
  })
}

function getAgentLabel(agentId: string): string {
  return getAgentCatalog().find((agent) => agent.id === agentId)?.label ?? agentId
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
  return manager.target.type === 'ssh' ? 'SSH host' : 'Local'
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
  if (run.precheckResult) {
    const output = [run.precheckResult.stderr.trim(), run.precheckResult.stdout.trim()]
      .filter(Boolean)
      .join('\n\n')
    if (output) {
      return output
    }
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
  const projectHostSetups = useAppStore((s) => s.projectHostSetups)
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
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const settings = useAppStore((s) => s.settings)
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusContextKey = useAppStore((s) => s.preflightStatusContextKey)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const expectedPreflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )
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
  const runtimePreflightMountedRef = useRef(true)
  const runtimePreflightRequestedHostIdsRef = useRef<Set<TaskSourceContext['hostId']>>(new Set())
  const [runtimePreflightStatusByHostId, setRuntimePreflightStatusByHostId] = useState<
    ReadonlyMap<TaskSourceContext['hostId'], RuntimeProviderPreflightStatus>
  >(() => new Map())
  const selectAutomationId = useCallback(
    (automationId: string | null): void => {
      setSelectedAutomationRunPageId(null)
      setSelectedId(automationId)
    },
    [setSelectedId]
  )
  const selectExternalKey = useCallback((externalKey: string | null): void => {
    setSelectedExternalRunPage(null)
    setSelectedExternalKey(externalKey)
  }, [])
  const [connectingExternalSourceKey, setConnectingExternalSourceKey] = useState<string | null>(
    null
  )
  const [draftAtOpen, setDraftAtOpen] = useState<AutomationDraft | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null)
  const [externalDeleteTarget, setExternalDeleteTarget] = useState<{
    manager: ExternalAutomationManager
    job: ExternalAutomationJob
  } | null>(null)
  useContextualTour(
    'automations',
    !createOpen && !deleteTarget && !externalDeleteTarget,
    'automations_open'
  )
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
    precheckCommand: '',
    precheckTimeoutSeconds: '60',
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
  const preflightStatusCurrent = preflightStatusContextKey === expectedPreflightContextKey
  const repoBackedAutomationSourceContexts = useMemo(
    () =>
      automations
        .map((automation) => getRepoBackedAutomationSourceContext(automation))
        .filter((context): context is RepoBackedAutomationSourceContext => context !== null),
    [automations]
  )
  const runtimeAutomationSourceHostIds = useMemo(() => {
    const hostIds = new Set<TaskSourceContext['hostId']>()
    for (const context of repoBackedAutomationSourceContexts) {
      const parsed = parseExecutionHostId(context.hostId)
      if (parsed?.kind !== 'runtime') {
        continue
      }
      const hostAvailability = getRuntimeSourceHostAvailability(
        context,
        runtimeStatusByEnvironmentId
      )
      if (hostAvailability) {
        continue
      }
      hostIds.add(parsed.id)
    }
    return [...hostIds].sort()
  }, [repoBackedAutomationSourceContexts, runtimeStatusByEnvironmentId])
  useEffect(
    () => () => {
      runtimePreflightMountedRef.current = false
    },
    []
  )
  useEffect(() => {
    if (!preflightStatusCurrent || !preflightStatusChecked) {
      void refreshPreflightStatus()
    }
  }, [preflightStatusChecked, preflightStatusCurrent, refreshPreflightStatus])
  useEffect(() => {
    const unrequestedHostIds = runtimeAutomationSourceHostIds.filter(
      (hostId) => !runtimePreflightRequestedHostIdsRef.current.has(hostId)
    )
    if (unrequestedHostIds.length === 0) {
      return
    }
    setRuntimePreflightStatusByHostId((current) => {
      const next = new Map(current)
      for (const hostId of unrequestedHostIds) {
        next.set(hostId, { checked: false, status: null })
      }
      return next
    })
    for (const hostId of unrequestedHostIds) {
      runtimePreflightRequestedHostIdsRef.current.add(hostId)
      const parsed = parseExecutionHostId(hostId)
      if (parsed?.kind !== 'runtime') {
        continue
      }
      // Why: automation sources can be owned by a different remote server than
      // the run target; provider auth/tooling must be checked on the source host.
      void callRuntimeRpc<PreflightStatus>(
        { kind: 'environment', environmentId: parsed.environmentId },
        'preflight.check',
        undefined,
        { timeoutMs: 15_000 }
      )
        .then((status) => {
          if (!runtimePreflightMountedRef.current) {
            return
          }
          setRuntimePreflightStatusByHostId((current) => {
            const next = new Map(current)
            next.set(hostId, { checked: true, status })
            return next
          })
        })
        .catch(() => {
          if (!runtimePreflightMountedRef.current) {
            return
          }
          setRuntimePreflightStatusByHostId((current) => {
            const next = new Map(current)
            next.set(hostId, { checked: true, status: null })
            return next
          })
        })
    }
  }, [runtimeAutomationSourceHostIds])
  const automationSourceHostAvailabilityById = useMemo(() => {
    const availabilityById = new Map<string, TaskSourceHostAvailability[]>()
    for (const automation of automations) {
      const context = getRepoBackedAutomationSourceContext(automation)
      if (!context) {
        continue
      }
      const hostAvailability = getRuntimeSourceHostAvailability(
        context,
        runtimeStatusByEnvironmentId
      )
      const providerAvailability = getRepoBackedProviderAvailability({
        provider: context.provider,
        contexts: [context],
        preflightStatus,
        preflightReady: preflightStatusCurrent && preflightStatusChecked,
        runtimePreflightStatusByHostId
      })
      const availability = [
        ...(hostAvailability ? [hostAvailability] : []),
        ...providerAvailability
      ]
      if (availability.length > 0) {
        availabilityById.set(automation.id, availability)
      }
    }
    return availabilityById
  }, [
    automations,
    preflightStatus,
    preflightStatusChecked,
    preflightStatusCurrent,
    runtimePreflightStatusByHostId,
    runtimeStatusByEnvironmentId
  ])
  const selectedRepo = selected ? (repoMap.get(getAutomationRunRepoId(selected)) ?? null) : null
  const selectedWorktree =
    selected && selected.workspaceId ? (worktreeMap.get(selected.workspaceId) ?? null) : null
  const selectedRunNowAvailability = selected
    ? getAutomationTargetAvailability({
        automation: selected,
        repo: selectedRepo,
        workspace: selectedWorktree,
        projectHostSetups,
        sshConnectionStates,
        runtimeStatusByEnvironmentId,
        sourceHostAvailability: automationSourceHostAvailabilityById.get(selected.id)
      })
    : null
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
  const selectedExternalSshStatus = selectedExternalSshSource
    ? sshConnectionStates.get(selectedExternalSshSource.connectionId)?.status
    : undefined
  const selectedExternalSshConnected = selectedExternalSshStatus === 'connected'
  const isSelectedExternalSshConnecting =
    selectedExternalSshSource !== null &&
    (connectingExternalSourceKey === selectedExternalSshSource.sourceKey ||
      isSshConnectionBusy(selectedExternalSshStatus))
  const selectedExternalSourceAvailability =
    selectedExternal?.kind === 'source'
      ? getExternalAutomationSourceAvailability({
          manager: selectedExternal.manager,
          providerLabel: getExternalProviderLabel(selectedExternal.manager),
          targetKindLabel: getExternalTargetKindLabel(selectedExternal.manager),
          sshStatus: selectedExternalSshStatus,
          isConnectingOverride: isSelectedExternalSshConnecting
        })
      : null

  const getAutomationRepoHostLabel = useCallback(
    (repo: Repo): string => {
      const hostId = getRepoExecutionHostId(repo)
      const parsed = parseExecutionHostId(hostId)
      if (parsed?.kind === 'ssh') {
        return sshTargetLabels.get(parsed.targetId) ?? parsed.targetId
      }
      if (parsed?.kind === 'runtime') {
        return (
          runtimeEnvironments.find((environment) => environment.id === parsed.environmentId)
            ?.name ?? parsed.environmentId
        )
      }
      return getLocalExecutionHostLabel()
    },
    [runtimeEnvironments, sshTargetLabels]
  )
  const hostLabelOverrides = useMemo(() => getHostDisplayLabelOverrides(settings), [settings])
  const hostLabelById = useMemo(() => {
    const labels = new Map<string, string>([['local', getLocalExecutionHostLabel()]])
    for (const [targetId, label] of sshTargetLabels) {
      labels.set(`ssh:${encodeURIComponent(targetId)}`, label)
    }
    for (const environment of runtimeEnvironments) {
      labels.set(`runtime:${encodeURIComponent(environment.id)}`, environment.name)
    }
    for (const [hostId, label] of hostLabelOverrides) {
      labels.set(hostId, label)
    }
    return labels
  }, [hostLabelOverrides, runtimeEnvironments, sshTargetLabels])

  useEffect(() => {
    if ((!selected || selectedExternal) && activePaneTab === 'runs') {
      setActivePaneTab('overview')
    }
  }, [activePaneTab, selected, selectedExternal])

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
    const automationHostTarget = getAutomationListTarget(settings)
    try {
      const [nextAutomations, nextRuns, nextExternalManagers] = await Promise.all([
        listAutomationsForTarget(automationHostTarget),
        listAutomationRunsForTarget(automationHostTarget),
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
        ? await listAutomationRunsForTarget(automationHostTarget, nextSelectedId)
        : []
      setAutomations(nextAutomations)
      setRuns(nextRuns)
      setSelectedAutomationRuns({
        automationId: nextSelectedId,
        runs: nextSelectedRuns
      })
      setExternalManagers(nextExternalManagers)
      if (!hasCurrentSelection) {
        selectAutomationId(nextAutomations[0]?.id ?? null)
      }
    } finally {
      setIsLoading(false)
    }
  }, [selectAutomationId, settings])

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
    void listAutomationRunsForTarget(getAutomationListTarget(settings), automationId).then(
      (nextRuns) => {
        if (!cancelled) {
          setSelectedAutomationRuns({ automationId, runs: nextRuns })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [selected?.id, runs, settings])

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
      precheckCommand: '',
      precheckTimeoutSeconds: '60',
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
      projectId: getAutomationRunRepoId(latest),
      workspaceMode: latest.workspaceMode,
      workspaceId: latest.workspaceId ?? '',
      baseBranch: latest.baseBranch ?? '',
      reuseSession: latest.workspaceMode === 'existing' && latest.reuseSession,
      precheckCommand: latest.precheck?.command ?? '',
      precheckTimeoutSeconds: String(latest.precheck?.timeoutSeconds ?? 60),
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
      precheckCommand: '',
      precheckTimeoutSeconds: '60',
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
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.2430fecf53',
          'Choose a run location and enter a prompt before saving.'
        )
      )
      return
    }
    if (draft.scheduleWarning) {
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.64bdb2304f',
          'Pick a supported schedule before saving.'
        )
      )
      return
    }
    const validateAdvancedSchedule = isHermesSave
      ? isValidAutomationCronSchedule
      : isValidAutomationSchedule
    if (draft.preset === 'custom' && !validateAdvancedSchedule(draft.customSchedule)) {
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.6e91dab317',
          'Enter a valid advanced schedule before saving.'
        )
      )
      return
    }
    if (
      editingAutomationId === null &&
      !isHermesSave &&
      !isTuiAgentEnabled(draft.agentId, settings?.disabledTuiAgents)
    ) {
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.2360ffc956',
          'Choose an enabled agent before saving.'
        )
      )
      return
    }
    setIsSaving(true)
    try {
      const selectedWorkspaceExists =
        draft.workspaceMode !== 'existing' ||
        worktrees.some((worktree) => worktree.id === draft.workspaceId)
      if (!selectedWorkspaceExists) {
        toast.error(
          translate(
            'auto.components.automations.AutomationsPage.32534e7c9c',
            'Choose an available workspace before saving.'
          )
        )
        return
      }
      if (isHermesSave) {
        const repo = repoMap.get(draft.projectId)
        const selectedWorktree = worktreeMap.get(draft.workspaceId) ?? null
        if (!repo || !selectedWorktree) {
          toast.error(
            translate(
              'auto.components.automations.AutomationsPage.32534e7c9c',
              'Choose an available workspace before saving.'
            )
          )
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
          toast.error(
            translate(
              'auto.components.automations.AutomationsPage.e431bb85d4',
              'Choose a workspace on the same host as this Hermes automation.'
            )
          )
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
        selectExternalKey(
          editingExternalTarget
            ? getExternalAutomationKey(editingExternalTarget.manager, editingExternalTarget.job)
            : null
        )
        toast.success(
          editingExternalTarget
            ? translate(
                'auto.components.automations.AutomationsPage.08efc3ae12',
                'Hermes automation updated.'
              )
            : translate(
                'auto.components.automations.AutomationsPage.77b81bc4ac',
                'Hermes automation created.'
              )
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
      const precheck = buildDraftPrecheck(draft)
      const runContext = buildAutomationRunContextForRepo({
        repoId: draft.projectId,
        repos,
        projectHostSetups
      })
      if (!runContext) {
        toast.error(
          translate(
            'auto.components.automations.AutomationsPage.32534e7c9c',
            'Choose an available workspace before saving.'
          )
        )
        return
      }
      let currentAutomation = editingAutomationId
        ? (automations.find((automation) => automation.id === editingAutomationId) ?? null)
        : null
      if (editingAutomationId) {
        try {
          currentAutomation =
            (await listAutomationsForTarget(getAutomationListTarget(settings))).find(
              (automation) => automation.id === editingAutomationId
            ) ?? currentAutomation
        } catch {
          // Keep the in-memory automation as a fallback if the refresh fails.
        }
      }
      const updates: AutomationUpdateInput = {
        name: draft.name,
        prompt: draft.prompt,
        precheck,
        agentId: draft.agentId,
        runContext,
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
        ? currentAutomation
          ? await updateAutomationForTarget(currentAutomation, updates)
          : await window.api.automations.update({
              id: editingAutomationId,
              updates
            })
        : await createAutomationForTarget({
            name: draft.name,
            prompt: draft.prompt,
            precheck,
            agentId: draft.agentId,
            runContext,
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
      selectAutomationId(automation.id)
      setCreateOpen(false)
      if (!editingAutomationId) {
        useAppStore.getState().recordFeatureInteraction('automation-created')
      }
      toast.success(
        editingAutomationId
          ? translate(
              'auto.components.automations.AutomationsPage.244727e655',
              'Automation updated.'
            )
          : translate('auto.components.automations.AutomationsPage.2a20596d6b', 'Automation saved.')
      )
    } catch (error) {
      if (isHermesSave) {
        await refresh().catch(() => undefined)
      }
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.automations.AutomationsPage.b11170a008',
              'Failed to save automation.'
            )
      )
    } finally {
      setIsSaving(false)
    }
  }

  const toggleAutomation = async (automation: Automation): Promise<void> => {
    await updateAutomationForTarget(automation, { enabled: !automation.enabled })
    await refresh()
  }

  const deleteAutomation = async (automation: Automation): Promise<void> => {
    await deleteAutomationForTarget(automation)
    if (useAppStore.getState().selectedAutomationId === automation.id) {
      selectAutomationId(null)
    }
    await refresh()
  }

  const persistDeleteAutomationPreference = (): void => {
    void updateSettings({ skipDeleteAutomationConfirm: true })
    toast.success(
      translate(
        'auto.components.automations.AutomationsPage.690b94da54',
        "We'll skip this confirmation next time."
      ),
      {
        description: translate(
          'auto.components.automations.AutomationsPage.d2a01b0b6f',
          'You can change this in Settings.'
        ),
        duration: 8000,
        action: {
          label: translate(
            'auto.components.automations.AutomationsPage.8a3226f172',
            'Open Settings'
          ),
          onClick: () => {
            openSettingsPage()
            openSettingsTarget({
              pane: 'general',
              repoId: null,
              sectionId: 'general-skip-delete-automation-confirm'
            })
          }
        }
      }
    )
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
    const repo = repoMap.get(getAutomationRunRepoId(automation)) ?? null
    const workspace = automation.workspaceId
      ? (worktreeMap.get(automation.workspaceId) ?? null)
      : null
    const availability = getAutomationTargetAvailability({
      automation,
      repo,
      workspace,
      projectHostSetups,
      sshConnectionStates,
      runtimeStatusByEnvironmentId,
      sourceHostAvailability: automationSourceHostAvailabilityById.get(automation.id)
    })
    if (!availability.canRunNow) {
      toast.error(availability.message)
      return
    }
    await runAutomationNowForTarget(automation)
    useAppStore.getState().recordFeatureInteraction('automation-run')
    await hydratePersistedUIState()
    await refresh()
    toast.message(
      translate('auto.components.automations.AutomationsPage.a1bdb57008', 'Automation run queued.')
    )
  }

  const rerunAutomationRun = async (automation: Automation, run: AutomationRun): Promise<void> => {
    const runId = run.id
    if (rerunRunIdsInFlightRef.current.has(runId)) {
      return
    }
    const pendingStartedAt = Date.now()
    rerunRunIdsInFlightRef.current.add(runId)
    setRerunRunIdsInFlight(new Set(rerunRunIdsInFlightRef.current))
    try {
      await runAutomationNowForTarget(automation)
      await hydratePersistedUIState()
      await refresh()
      toast.message(
        translate(
          'auto.components.automations.AutomationsPage.a1bdb57008',
          'Automation run queued.'
        )
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.automations.AutomationsPage.3a4c476aa0',
              'Failed to rerun automation.'
            )
      )
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
          ? translate(
              'auto.components.automations.AutomationsPage.4c22bc9913',
              'External automation deleted.'
            )
          : action === 'run'
            ? translate(
                'auto.components.automations.AutomationsPage.4d7878402c',
                'External automation queued.'
              )
            : action === 'pause'
              ? translate(
                  'auto.components.automations.AutomationsPage.77c518a34b',
                  'External automation paused.'
                )
              : translate(
                  'auto.components.automations.AutomationsPage.37288942f0',
                  'External automation resumed.'
                )
      )
    } catch (error) {
      await refresh().catch(() => undefined)
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.automations.AutomationsPage.126d726546',
              'External automation action failed.'
            )
      )
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
      if (sshConnectionStates.get(manager.target.connectionId)?.status === 'connected') {
        await refresh()
        toast.success(
          translate(
            'auto.components.automations.AutomationsPage.a21f6c33ad',
            'Automation source refreshed.'
          )
        )
        return
      }
      const state = await window.api.ssh.connect({ targetId: manager.target.connectionId })
      if (!state || state.status !== 'connected') {
        toast.error(
          state?.error ??
            translate(
              'auto.components.automations.AutomationsPage.7b2e285552',
              'SSH connections are unavailable in this client.'
            )
        )
        return
      }
      await refresh()
      toast.success(
        translate('auto.components.automations.AutomationsPage.9f2855677c', 'SSH connected.')
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.automations.AutomationsPage.3e42a5cc1b',
              'SSH connection failed.'
            )
      )
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
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.e1bf9b1512',
          'Workspace is not available.'
        )
      )
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
                aria-label={translate(
                  'auto.components.automations.AutomationsPage.67c7ff795b',
                  'Close automations'
                )}
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.automations.AutomationsPage.0329f9bef1', 'Close · Esc')}
            </TooltipContent>
          </Tooltip>
          <div className="mx-1 h-5 w-px bg-border/50" aria-hidden />
          <CalendarClock className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold">
            {translate('auto.components.automations.AutomationsPage.77c2778945', 'Automations')}
          </h1>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={translate(
                  'auto.components.automations.AutomationsPage.8d1afa8269',
                  'Add automation'
                )}
                onClick={() => openCreateDialog()}
                className="border border-border/50 bg-transparent hover:bg-muted/50"
                data-contextual-tour-target="automations-create"
              >
                <Plus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate(
                'auto.components.automations.AutomationsPage.8d1afa8269',
                'Add automation'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={translate(
                  'auto.components.automations.AutomationsPage.19a6e30eae',
                  'Refresh automations'
                )}
                onClick={refresh}
                disabled={isLoading}
                className="border border-border/50 bg-transparent hover:bg-muted/50"
              >
                <RefreshCw className={cn('size-4', isLoading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate(
                'auto.components.automations.AutomationsPage.19a6e30eae',
                'Refresh automations'
              )}
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
        getRepoHostLabel={getAutomationRepoHostLabel}
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
            <DialogTitle className="text-sm">
              {translate(
                'auto.components.automations.AutomationsPage.080dcb5fbb',
                'Delete Automation'
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {translate('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}{' '}
              <span className="break-all font-medium text-foreground">{deleteTarget?.name}</span>{' '}
              {translate(
                'auto.components.automations.AutomationsPage.b264564427',
                'and its run history. Workspaces created by previous runs are not deleted.'
              )}
            </DialogDescription>
          </DialogHeader>
          {deleteTarget ? (
            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
              <div className="break-all font-medium text-foreground">{deleteTarget.name}</div>
              <div className="mt-1 text-muted-foreground">
                {deleteTarget.workspaceMode === 'new_per_run'
                  ? translate(
                      'auto.components.automations.AutomationsPage.cd8397cc32',
                      'New workspace each run'
                    )
                  : translate(
                      'auto.components.automations.AutomationsPage.36f71740a7',
                      'Selected workspace'
                    )}
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
            {translate('auto.components.automations.AutomationsPage.1e2e41392f', "Don't ask again")}
          </button>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteTarget(null)
                setDontAskDeleteAgain(false)
              }}
            >
              {translate('auto.components.automations.AutomationsPage.73f630b49d', 'Cancel')}
            </Button>
            <Button
              ref={deleteConfirmButtonRef}
              variant="destructive"
              onClick={() => void confirmDeleteAutomation()}
            >
              <Trash2 className="size-4" />
              {translate('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}
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
            <DialogTitle className="text-sm">
              {translate(
                'auto.components.automations.AutomationsPage.9adfab2596',
                'Delete External Automation'
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {translate('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}{' '}
              <span className="break-all font-medium text-foreground">
                {externalDeleteTarget?.job.name}
              </span>{' '}
              {translate('auto.components.automations.AutomationsPage.02a33e3204', 'from')}{' '}
              {externalDeleteTarget
                ? getExternalProviderLabel(externalDeleteTarget.manager)
                : translate(
                    'auto.components.automations.AutomationsPage.8500baacb4',
                    'external source'
                  )}{' '}
              {translate('auto.components.automations.AutomationsPage.1b586f0e2b', 'on')}
              {externalDeleteTarget?.manager.targetLabel}.
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
              {translate('auto.components.automations.AutomationsPage.73f630b49d', 'Cancel')}
            </Button>
            <Button
              ref={deleteConfirmButtonRef}
              variant="destructive"
              onClick={() => void confirmDeleteExternalAutomation()}
            >
              <Trash2 className="size-4" />
              {translate('auto.components.automations.AutomationsPage.15e0bfb13b', 'Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,360px)_1fr] overflow-hidden border-t border-border/50">
        <section
          className="flex min-h-0 flex-col border-r border-border/50 bg-muted/20"
          data-contextual-tour-target="automations-list"
        >
          <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto p-2">
            {automations.length + externalAutomationEntries.length > 0 ? (
              <div className="grid grid-cols-[1fr_auto] gap-2 px-2 pb-2 text-[11px] font-medium uppercase text-muted-foreground">
                <span>
                  {translate(
                    'auto.components.automations.AutomationsPage.761a35834d',
                    'Automation'
                  )}
                </span>
                <span>
                  {translate('auto.components.automations.AutomationsPage.587a4b205c', 'Next')}
                </span>
              </div>
            ) : null}
            {automations.map((automation) => {
              const automationRepo = repoMap.get(getAutomationRunRepoId(automation))
              const automationWorktree = automation.workspaceId
                ? worktreeMap.get(automation.workspaceId)
                : null
              const automationRunAvailability = getAutomationTargetAvailability({
                automation,
                repo: automationRepo,
                workspace: automationWorktree,
                projectHostSetups,
                sshConnectionStates,
                runtimeStatusByEnvironmentId,
                sourceHostAvailability: automationSourceHostAvailabilityById.get(automation.id)
              })
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
                        selectExternalKey(null)
                        selectAutomationId(automation.id)
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
                            <span>
                              {translate(
                                'auto.components.automations.AutomationsPage.13118faadf',
                                'Unknown project'
                              )}
                            </span>
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
                    <ContextMenuItem
                      disabled={!automationRunAvailability.canRunNow}
                      onSelect={(event) => {
                        if (!automationRunAvailability.canRunNow) {
                          event.preventDefault()
                          return
                        }
                        void runNow(automation)
                      }}
                    >
                      <Play className="size-3.5" />
                      <span className="min-w-0 truncate">
                        {automationRunAvailability.canRunNow
                          ? translate(
                              'auto.components.automations.AutomationsPage.2faecab10b',
                              'Run Now'
                            )
                          : automationRunAvailability.message}
                      </span>
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void openEditDialog(automation)}>
                      <Pencil className="size-3.5" />
                      {translate('auto.components.automations.AutomationsPage.f4612e3f78', 'Edit')}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void toggleAutomation(automation)}>
                      {automation.enabled ? (
                        <Pause className="size-3.5" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                      {automation.enabled
                        ? translate(
                            'auto.components.automations.AutomationsPage.b457436d6a',
                            'Pause'
                          )
                        : translate(
                            'auto.components.automations.AutomationsPage.376631ef2b',
                            'Resume'
                          )}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      onSelect={() => requestDeleteAutomation(automation)}
                    >
                      <Trash2 className="size-3.5" />
                      {translate(
                        'auto.components.automations.AutomationsPage.15e0bfb13b',
                        'Delete'
                      )}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )
            })}
            {externalAutomationEntries.map((entry) => {
              const providerLabel = getExternalProviderLabel(entry.manager)
              const targetKindLabel = getExternalTargetKindLabel(entry.manager)
              if (entry.kind === 'source') {
                const sshStatus =
                  entry.manager.target.type === 'ssh'
                    ? sshConnectionStates.get(entry.manager.target.connectionId)?.status
                    : undefined
                const sourceAvailability = getExternalAutomationSourceAvailability({
                  manager: entry.manager,
                  providerLabel,
                  targetKindLabel,
                  sshStatus
                })
                return (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => {
                      selectExternalKey(entry.key)
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
                        <span>
                          {providerLabel}{' '}
                          {translate(
                            'auto.components.automations.AutomationsPage.82eb6cb933',
                            'source'
                          )}
                        </span>
                        <span className="shrink-0">/</span>
                        <span className="truncate">{targetKindLabel}</span>
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {sourceAvailability.summary}
                      </span>
                    </span>
                    <span className="flex max-w-28 flex-col items-end gap-1 text-right text-xs text-muted-foreground">
                      <Clock className="size-3.5" />
                      <span className="line-clamp-2">{sourceAvailability.statusLabel}</span>
                    </span>
                  </button>
                )
              }
              const nextRunLabel = entry.job.enabled
                ? formatExternalDate(entry.job.nextRunAt, relativeNow)
                : 'Paused'
              const entrySshStatus =
                entry.manager.target.type === 'ssh'
                  ? sshConnectionStates.get(entry.manager.target.connectionId)?.status
                  : undefined
              const disabledMessage = getExternalAutomationActionDisabledMessage({
                manager: entry.manager,
                providerLabel,
                targetKindLabel,
                sshStatus: entrySshStatus,
                actionInProgress: externalActionKey !== null
              })
              const actionDisabled = disabledMessage !== null
              const scheduleDisplay = getExternalAutomationScheduleDisplay(entry.manager, entry.job)
              return (
                <ContextMenu key={entry.key}>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        selectExternalKey(entry.key)
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
                                ? translate(
                                    'auto.components.automations.AutomationsPage.aecdc3681f',
                                    'Manageable'
                                  )
                                : translate(
                                    'auto.components.automations.AutomationsPage.e059042585',
                                    'Read-only'
                                  )}
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
                      <span className="min-w-0 truncate">
                        {disabledMessage ??
                          translate(
                            'auto.components.automations.AutomationsPage.2faecab10b',
                            'Run Now'
                          )}
                      </span>
                    </ContextMenuItem>
                    {entry.manager.provider === 'hermes' ? (
                      <ContextMenuItem
                        disabled={!entry.manager.canManage || externalActionKey !== null}
                        onSelect={() => openEditExternalDialog(entry.manager, entry.job)}
                      >
                        <Pencil className="size-3.5" />
                        {translate(
                          'auto.components.automations.AutomationsPage.f4612e3f78',
                          'Edit'
                        )}
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
                      {entry.job.enabled
                        ? translate(
                            'auto.components.automations.AutomationsPage.b457436d6a',
                            'Pause'
                          )
                        : translate(
                            'auto.components.automations.AutomationsPage.376631ef2b',
                            'Resume'
                          )}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      disabled={actionDisabled}
                      onSelect={() => requestExternalAction(entry.manager, entry.job, 'delete')}
                    >
                      <Trash2 className="size-3.5" />
                      {translate(
                        'auto.components.automations.AutomationsPage.15e0bfb13b',
                        'Delete'
                      )}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )
            })}
            {automations.length === 0 && externalAutomationEntries.length === 0 ? (
              <div className="grid gap-2 p-2">
                <div className="px-1 pb-1 text-sm font-medium">
                  {translate(
                    'auto.components.automations.AutomationsPage.d207ab4c25',
                    'Start from a template'
                  )}
                </div>
                {getAutomationTemplates().map((template) => (
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
                  {translate('auto.components.automations.AutomationsPage.25060635c6', 'Add new')}
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
                        {selectedExternalSourceAvailability?.summary}
                      </div>
                    </div>
                    {selectedExternalSshSource ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={selectedExternalSourceAvailability?.isConnecting ?? false}
                        onClick={() =>
                          void connectExternalAutomationSource(selectedExternalSshSource.manager)
                        }
                      >
                        {selectedExternalSourceAvailability?.isConnecting ? (
                          <RefreshCw className="size-3.5 animate-spin" />
                        ) : null}
                        {selectedExternalSourceAvailability?.isConnecting
                          ? translate(
                              'auto.components.automations.AutomationsPage.f93ed7a6f8',
                              'Connecting...'
                            )
                          : selectedExternalSshConnected
                            ? translate(
                                'auto.components.automations.AutomationsPage.53f06f0ad5',
                                'Retry source'
                              )
                            : translate(
                                'auto.components.automations.AutomationsPage.7934ee0d81',
                                'Connect SSH'
                              )}
                      </Button>
                    ) : null}
                  </div>
                  <div className="px-3 py-6 text-sm text-muted-foreground">
                    {selectedExternalSourceAvailability?.detail}
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
              <div
                className="flex shrink-0 items-center justify-between border-b border-border/50 px-5 py-2"
                data-contextual-tour-target="automations-runs"
              >
                <TabsList variant="line" className="h-8">
                  <TabsTrigger value="overview">
                    {translate(
                      'auto.components.automations.AutomationsPage.bb1b2cd31e',
                      'Overview'
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="runs" disabled={!selected}>
                    {translate('auto.components.automations.AutomationsPage.0e110a3469', 'Runs')}
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
                  hostLabelById={hostLabelById}
                  runNowAvailability={selectedRunNowAvailability}
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
                            {translate(
                              'auto.components.automations.AutomationsPage.295698292f',
                              'Rerun'
                            )}
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
                    {translate(
                      'auto.components.automations.AutomationsPage.c3a28c9793',
                      'Select an automation to view runs.'
                    )}
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
