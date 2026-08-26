/* eslint-disable max-lines -- Why: this page owns the automations list/detail
 * orchestration while the form, list, and detail presentation live in sibling files. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { filterEnabledTuiAgents, isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { getAgentCatalog } from '@/lib/agent-catalog'
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
import { getAutomationRunRepoId } from '../../../../shared/automation-run-identity'
import {
  getLocalExecutionHostLabel,
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import type { PreflightStatus } from '../../../../preload/api-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import type { Repo } from '../../../../shared/repo-types'
import { getWorktreePathBasenameFromId } from '../../../../shared/worktree/id'
import {
  buildAutomationRrule,
  isValidAutomationCronSchedule,
  isValidAutomationSchedule,
  tryParseAutomationRrule
} from '../../../../shared/automation-schedules'
import {
  canRerunAutomationRun,
  getAutomationRunViewState,
  waitForAutomationRerunPendingVisibility
} from './automation-run-view-state'
import {
  buildAutomationRunOpenLayout,
  canOpenAutomationRunOpenTarget,
  getAutomationRunOpenTabId,
  resolveAutomationRunOpenTarget
} from './automation-run-open-target'
import { hasAutomationRunCompletionEvidence } from './automation-run-completion-evidence'
import { getAutomationRunWorkspaceDisplay } from './automation-run-workspace-display'
import {
  AutomationEditorDialog,
  type AutomationCreateTarget,
  type AutomationDraft
} from './AutomationEditorDialog'
import {
  getAutomationSetupDecisionDraftValue,
  getVisibleAutomationSetupDecision,
  resolveAutomationSetupDecisionForSave
} from './automation-setup-decision'
import type { AutomationTemplate } from './automation-templates'
import { getAutomationTargetAvailability } from './automation-target-availability'
import { getAutomationCreateAvailability } from './automation-create-admission'
import { buildAutomationRunContextForRepo } from './automation-run-context'
import {
  repoMatchesExternalAutomationTarget,
  getExternalAutomationTargetForRepo
} from './automation-external-target-match'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import {
  getRepoBackedProviderAvailability,
  type RuntimeProviderPreflightStatus
} from '../task-source-provider-availability'
import type { TaskSourceHostAvailability } from '../task-source-context-summary'

import {
  createAutomationForTarget,
  deleteAutomationForTarget,
  getAutomationHostTargetFromKey,
  getAutomationHostTargetKey,
  getAutomationListTarget,
  getAutomationOwnerTarget,
  getAutomationTargetFromHostId,
  listAutomationRunsForTarget,
  listAutomationsForTarget,
  runAutomationNowForTarget,
  updateAutomationForTarget
} from './automation-host-client'
import { getAutomationCreateRepos } from './automation-create-projects'
import type { FetchExternalAutomationRuns } from './ExternalAutomationRunTable'
import {
  AUTOMATION_DEFAULT_TIME,
  buildDraftPrecheck,
  buildHermesCronSchedule,
  formatTimeInput,
  getDefaultWorktree,
  parseDraftTime
} from './automation-draft-model'
import {
  getRepoBackedAutomationSourceContext,
  getRuntimeSourceHostAvailability,
  type RepoBackedAutomationSourceContext
} from './automation-source-context'
import type { AutomationPaneTab, SelectedExternalRunPage } from './automation-page-state'
import {
  getExternalAutomationKey,
  isMissingExternalRunsApiError
} from './external-automation-display'
import { buildExternalAutomationListEntries } from './external-automation-list-entries'
import { shouldCloseDetailForLostSelection } from './automation-detail-selection'
import { useAutomationListSearch } from './use-automation-list-search'
import { useAutomationListView } from './use-automation-list-view'
import {
  EMPTY_AUTOMATION_LIST_FILTER,
  nextAutomationListSort,
  type AutomationListFilter,
  type AutomationListSort
} from './automation-list-view'
import { AutomationDeleteDialog, ExternalAutomationDeleteDialog } from './AutomationDeleteDialogs'
import { AutomationsListPanel } from './AutomationsListPanel'
import { AutomationsDetailPane } from './AutomationsDetailPane'
import { AutomationsPageSkeleton } from './AutomationsPageSkeleton'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { translate } from '@/i18n/i18n'

const AGENTS = getAgentCatalog().map((agent) => agent.id)
const AUTOMATIONS_CHANGED_EVENT = 'orca:automations-changed'
export default function AutomationsPage(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const projectHostSetups = useAppStore((s) => s.projectHostSetups)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const unifiedTabsByWorktree = useAppStore((s) => s.unifiedTabsByWorktree)
  const terminalLayoutsByTabId = useAppStore((s) => s.terminalLayoutsByTabId)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const fetchAllWorktrees = useAppStore((s) => s.fetchAllWorktrees)
  const startupWorktreeRefreshCompleted = useAppStore((s) => s.startupWorktreeRefreshCompleted)
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
  const pendingAutomationRunNavigation = useAppStore((s) => s.pendingAutomationRunNavigation)
  const setPendingAutomationRunNavigation = useAppStore((s) => s.setPendingAutomationRunNavigation)
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
  const [automationHostTargetKey, setAutomationHostTargetKey] = useState<string | null>(null)
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
  const [listSearchQuery, setListSearchQuery] = useState('')
  const [listFilter, setListFilter] = useState<AutomationListFilter>(EMPTY_AUTOMATION_LIST_FILTER)
  const [listSort, setListSort] = useState<AutomationListSort | null>(null)
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
  // Why: list is the primary surface; detail is a full-page drill-in, not a side pane.
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const selectedExternalKeyRef = useRef<string | null>(null)
  const isDetailOpenRef = useRef(false)
  // Keep async refresh/delete handlers reading the latest selection without render-time mutation.
  useEffect(() => {
    selectedExternalKeyRef.current = selectedExternalKey
  }, [selectedExternalKey])
  useEffect(() => {
    isDetailOpenRef.current = isDetailOpen
  }, [isDetailOpen])
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
  const [draftAtOpen, setDraftAtOpen] = useState<AutomationDraft | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null)
  const [externalDeleteTarget, setExternalDeleteTarget] = useState<{
    manager: ExternalAutomationManager
    job: ExternalAutomationJob
  } | null>(null)
  useContextualTour(
    'automations',
    !isLoading && !createOpen && !deleteTarget && !externalDeleteTarget,
    'automations_open'
  )
  const [editingExternalTarget, setEditingExternalTarget] = useState<{
    manager: ExternalAutomationManager
    job: ExternalAutomationJob
  } | null>(null)
  const [dontAskDeleteAgain, setDontAskDeleteAgain] = useState(false)
  const editRequestRef = useRef(0)
  const deleteConfirmButtonRef = useRef<HTMLButtonElement>(null)
  // Why: both dialogs stay mounted, so a shared ref would let one dialog's
  // unmount clear the focus target the other still needs.
  const externalDeleteConfirmButtonRef = useRef<HTMLButtonElement>(null)
  const completionInFlightRef = useRef<Set<string>>(new Set())
  const rerunRunIdsInFlightRef = useRef<Set<string>>(new Set())
  const workspaceNameCacheRef = useRef<Map<string, string>>(new Map())
  const setupDecisionPolicyDefaultRef = useRef<AutomationDraft['setupDecision']>(undefined)
  const setupDecisionDefaultSignatureRef = useRef<string | null>(null)
  const setupDecisionTouchedRef = useRef(false)
  const automationHookCheckPromisesRef = useRef<
    Map<string, Promise<{ hooks: OrcaHooks | null; ok: boolean }>>
  >(new Map())
  const [automationYamlHooksByRepoKey, setAutomationYamlHooksByRepoKey] = useState<
    Record<string, OrcaHooks | null>
  >({})
  const [draft, setDraft] = useState<AutomationDraft>({
    name: '',
    prompt: '',
    agentId: defaultAgent,
    projectId: '',
    workspaceMode: 'existing',
    workspaceId: '',
    baseBranch: '',
    setupDecision: undefined,
    reuseSession: false,
    precheckCommand: '',
    precheckTimeoutSeconds: '60',
    preset: 'weekdays',
    time: AUTOMATION_DEFAULT_TIME,
    dayOfWeek: '1',
    customSchedule: '',
    missedRunGraceMinutes: '720',
    scheduleWarning: null
  })

  const externalAutomationEntries = useMemo(
    () => buildExternalAutomationListEntries(externalManagers),
    [externalManagers]
  )
  const {
    isListSearchQueryTooLarge,
    isListSearchActive,
    filteredAutomations,
    filteredExternalAutomationEntries,
    hasListItems
  } = useAutomationListSearch({
    listSearchQuery,
    automations,
    externalAutomationEntries,
    repoMap,
    selectedId,
    selectedExternalKey,
    selectAutomationId,
    selectExternalKey
  })
  const {
    visibleItems,
    isListFilterActive,
    hasVisibleListItems: hasFilteredListItems
  } = useAutomationListView({
    automations: filteredAutomations,
    externalEntries: filteredExternalAutomationEntries,
    runs,
    filter: listFilter,
    sort: listSort,
    selectedId,
    selectedExternalKey,
    selectAutomationId,
    selectExternalKey
  })

  const selectedExternal =
    externalAutomationEntries.find((entry) => entry.key === selectedExternalKey) ??
    (automations.length === 0 ? (externalAutomationEntries[0] ?? null) : null)
  const selected =
    selectedExternal === null
      ? selectedId
        ? (automations.find((automation) => automation.id === selectedId) ?? null)
        : (automations[0] ?? null)
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
  const getDraftSetupDecisionDefault = useCallback(
    (
      candidate: Pick<AutomationDraft, 'projectId' | 'workspaceMode'>
    ): AutomationDraft['setupDecision'] => {
      const settingsForRepo = getSettingsForRepoRuntimeOwner(
        { repos, settings },
        candidate.projectId
      )
      const hookKey = `${settingsForRepo.activeRuntimeEnvironmentId ?? 'local'}:${candidate.projectId}`
      return getVisibleAutomationSetupDecision({
        createTarget,
        workspaceMode: candidate.workspaceMode,
        repoId: candidate.projectId,
        repos,
        projectHostSetups,
        yamlHooks: automationYamlHooksByRepoKey[hookKey]
      })
    },
    [automationYamlHooksByRepoKey, createTarget, projectHostSetups, repos, settings]
  )
  const getAutomationHooksCacheKey = useCallback(
    (repoId: string): string => {
      const settingsForRepo = getSettingsForRepoRuntimeOwner({ repos, settings }, repoId)
      return `${settingsForRepo.activeRuntimeEnvironmentId ?? 'local'}:${repoId}`
    },
    [repos, settings]
  )
  const loadAutomationYamlHooksForRepo = useCallback(
    async (repoId: string): Promise<OrcaHooks | null> => {
      const key = getAutomationHooksCacheKey(repoId)
      if (Object.hasOwn(automationYamlHooksByRepoKey, key)) {
        return automationYamlHooksByRepoKey[key] ?? null
      }
      const existingPromise = automationHookCheckPromisesRef.current.get(key)
      if (existingPromise) {
        return (await existingPromise).hooks
      }
      const settingsForRepo = getSettingsForRepoRuntimeOwner({ repos, settings }, repoId)
      const promise = checkRuntimeHooks(settingsForRepo, repoId)
        .then((result) => ({
          hooks: result.status === 'error' ? null : ((result.hooks as OrcaHooks | null) ?? null),
          ok: result.status !== 'error'
        }))
        .catch(() => ({ hooks: null, ok: false }))
      automationHookCheckPromisesRef.current.set(key, promise)
      const { hooks, ok } = await promise
      automationHookCheckPromisesRef.current.delete(key)
      if (!ok) {
        return hooks
      }
      setAutomationYamlHooksByRepoKey((current) =>
        Object.hasOwn(current, key) ? current : { ...current, [key]: hooks }
      )
      return hooks
    },
    [automationYamlHooksByRepoKey, getAutomationHooksCacheKey, repos, settings]
  )
  const getDraftSetupDecisionDefaultSignature = useCallback(
    (candidate: Pick<AutomationDraft, 'projectId' | 'workspaceMode'>): string =>
      [
        createTarget,
        candidate.workspaceMode,
        candidate.projectId,
        getDraftSetupDecisionDefault(candidate) ?? 'none'
      ].join(':'),
    [createTarget, getDraftSetupDecisionDefault]
  )
  const markSetupDecisionTouched = useCallback((): void => {
    setupDecisionTouchedRef.current = true
  }, [])
  // Why: keep the detail tab scoped even while the selected-run fetch catches up.
  const selectedRunsSource =
    selected && selectedAutomationRuns.automationId === selected.id
      ? selectedAutomationRunsWithWorkspaceNames
      : runsWithWorkspaceNames
  const selectedRuns = useMemo(
    () => (selected ? selectedRunsSource.filter((run) => run.automationId === selected.id) : []),
    [selected, selectedRunsSource]
  )
  const selectedAutomationRunPage = selectedAutomationRunPageId
    ? (selectedRuns.find((run) => run.id === selectedAutomationRunPageId) ?? null)
    : null
  const worktrees = useMemo(
    () => worktreesByRepo[draft.projectId] ?? [],
    [draft.projectId, worktreesByRepo]
  )
  const automationHostTarget = useMemo(
    () => getAutomationHostTargetFromKey(automationHostTargetKey),
    [automationHostTargetKey]
  )

  useEffect(() => {
    for (const [workspaceId, worktree] of worktreeMap) {
      const displayName = worktree.displayName.trim()
      if (displayName) {
        workspaceNameCacheRef.current.set(workspaceId, displayName)
      }
    }
  }, [worktreeMap])
  useEffect(() => {
    if (!pendingAutomationRunNavigation || isLoading) {
      return
    }
    const pending = pendingAutomationRunNavigation
    const pendingTargetKey = getAutomationHostTargetKey(
      getAutomationTargetFromHostId(pending.hostId)
    )
    if (automationHostTargetKey !== pendingTargetKey) {
      return
    }
    const pendingAutomation = automations.find(
      (automation) => automation.id === pending.automationId
    )
    // Why: external selection wins over local in detail resolution; clear it so
    // pending local navigation cannot open the wrong automation.
    if (selectedExternalKey !== null) {
      selectExternalKey(null)
    }
    if (!pendingAutomation) {
      // Why: stale provenance should not silently select the first automation.
      setSelectedId(pending.automationId)
      setSelectedAutomationRunPageId(null)
      setPendingAutomationRunNavigation(null)
      toast.message(
        translate(
          'auto.components.automations.AutomationsPage.pendingAutomationMissing',
          'Automation no longer available.'
        )
      )
      return
    }
    if (selectedId !== pending.automationId) {
      setSelectedId(pending.automationId)
      setIsDetailOpen(true)
      return
    }
    if (!pending.runId) {
      setIsDetailOpen(true)
      setActivePaneTab('overview')
      setSelectedAutomationRunPageId(null)
      setPendingAutomationRunNavigation(null)
      return
    }
    if (selectedAutomationRuns.automationId !== pending.automationId) {
      return
    }
    setIsDetailOpen(true)
    setActivePaneTab('runs')
    const pendingRun = selectedRuns.find((run) => run.id === pending.runId)
    if (pendingRun) {
      setSelectedAutomationRunPageId(pending.runId)
      setPendingAutomationRunNavigation(null)
      return
    }
    setSelectedAutomationRunPageId(null)
    setPendingAutomationRunNavigation(null)
    toast.message(
      translate(
        'auto.components.automations.AutomationsPage.pendingAutomationRunMissing',
        'Run history no longer available.'
      )
    )
  }, [
    automations,
    automationHostTargetKey,
    isLoading,
    pendingAutomationRunNavigation,
    selectExternalKey,
    selectedAutomationRuns.automationId,
    selectedExternalKey,
    selectedId,
    selectedRuns,
    setPendingAutomationRunNavigation,
    setSelectedId
  ])
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
  const selectedAutomationRunPageOpenTabId = selectedAutomationRunPage
    ? getAutomationRunOpenTabId(selectedAutomationRunPage)
    : null
  const selectedAutomationRunPageViewState = selectedAutomationRunPage
    ? getAutomationRunViewState({
        run: selectedAutomationRunPage,
        workspaceExists: Boolean(selectedAutomationRunPageWorktree),
        terminalTargetExists: canOpenAutomationRunOpenTarget({
          run: selectedAutomationRunPage,
          terminalTabExists: selectedAutomationRunPageOpenTabId
            ? activeTerminalTabIds.has(selectedAutomationRunPageOpenTabId)
            : false,
          currentLayout: selectedAutomationRunPageOpenTabId
            ? terminalLayoutsByTabId[selectedAutomationRunPageOpenTabId]
            : null,
          livePtyIds: selectedAutomationRunPageOpenTabId
            ? (ptyIdsByTabId[selectedAutomationRunPageOpenTabId] ?? [])
            : []
        })
      })
    : null
  const canRerunSelectedAutomationRunPage =
    selectedAutomationRunPage !== null &&
    canRerunAutomationRun({
      automation: selected,
      run: selectedAutomationRunPage
    })
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
        automationHostTarget,
        sourceHostAvailability: automationSourceHostAvailabilityById.get(selected.id)
      })
    : null
  const canSaveDraft =
    editingAutomationId === null ||
    !draftAtOpen ||
    JSON.stringify(draft) !== JSON.stringify(draftAtOpen)
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
    const destinationTarget = getAutomationListTarget(settings)
    const eligibleRepos = getAutomationCreateRepos(repos, destinationTarget)
    const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null
    const activeRepo = activeWorktree ? (repoMap.get(activeWorktree.repoId) ?? null) : null
    const fallbackRepo =
      (activeRepo &&
      eligibleRepos.some(
        (repo) =>
          repo.id === activeRepo.id &&
          getRepoExecutionHostId(repo) === getRepoExecutionHostId(activeRepo)
      )
        ? activeRepo
        : null) ??
      eligibleRepos[0] ??
      null
    const fallbackWorktrees = fallbackRepo ? (worktreesByRepo[fallbackRepo.id] ?? []) : []
    // Why: automation-created workspaces can be active; new automations should start from
    // the repo's stable main worktree unless the user explicitly chooses otherwise.
    const targetWorktree = fallbackRepo ? getDefaultWorktree(fallbackWorktrees) : null
    const targetProjectId = fallbackRepo?.id ?? ''
    return {
      projectId: targetProjectId,
      workspaceId: targetWorktree?.id ?? ''
    }
  }, [activeWorktreeId, repoMap, repos, settings, worktreeMap, worktreesByRepo])

  const canCreateAutomation = getAutomationCreateAvailability({
    automationHostTarget: getAutomationListTarget(settings),
    runtimeStatusByEnvironmentId
  }).canRunNow
  const editingAutomation = editingAutomationId
    ? (automations.find((automation) => automation.id === editingAutomationId) ?? null)
    : null
  const automationDialogTarget = editingAutomation
    ? getAutomationOwnerTarget(editingAutomation, automationHostTarget)
    : getAutomationListTarget(settings)
  const isOrcaForm = createTarget === 'orca' && editingExternalTarget === null
  const dialogRepos = isOrcaForm
    ? getAutomationCreateRepos(repos, automationDialogTarget)
    : getAutomationCreateRepos(repos, { kind: 'local' })

  const refresh = useCallback(async () => {
    setIsLoading(true)
    const pendingNavigation = useAppStore.getState().pendingAutomationRunNavigation
    const automationHostTarget = pendingNavigation
      ? getAutomationTargetFromHostId(pendingNavigation.hostId)
      : getAutomationListTarget(settings)
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
      let nextSelectedId: string | null
      if (hasCurrentSelection) {
        nextSelectedId = currentSelectedId
      } else if (pendingNavigation) {
        nextSelectedId = pendingNavigation.automationId
      } else {
        nextSelectedId = nextAutomations[0]?.id ?? null
      }
      const nextSelectedRuns = nextSelectedId
        ? await listAutomationRunsForTarget(automationHostTarget, nextSelectedId)
        : []
      setAutomations(nextAutomations)
      setRuns(nextRuns)
      setAutomationHostTargetKey(getAutomationHostTargetKey(automationHostTarget))
      setSelectedAutomationRuns({
        automationId: nextSelectedId,
        runs: nextSelectedRuns
      })
      setExternalManagers(nextExternalManagers)
      if (!hasCurrentSelection && !pendingNavigation) {
        selectAutomationId(nextAutomations[0]?.id ?? null)
        if (
          shouldCloseDetailForLostSelection({
            isDetailOpen: isDetailOpenRef.current,
            hasPendingNavigation: false,
            isSelectedAutomationInNextList: false,
            isSelectedExternalInNextList: buildExternalAutomationListEntries(
              nextExternalManagers
            ).some((entry) => entry.key === selectedExternalKeyRef.current)
          })
        ) {
          setIsDetailOpen(false)
          setSelectedAutomationRunPageId(null)
          setSelectedExternalRunPage(null)
          setActivePaneTab('overview')
        }
      }
    } finally {
      setIsLoading(false)
    }
  }, [selectAutomationId, settings])

  useEffect(() => {
    if (!pendingAutomationRunNavigation || isLoading) {
      return
    }
    const pendingTargetKey = getAutomationHostTargetKey(
      getAutomationTargetFromHostId(pendingAutomationRunNavigation.hostId)
    )
    if (automationHostTargetKey !== pendingTargetKey) {
      void refresh()
    }
  }, [automationHostTargetKey, isLoading, pendingAutomationRunNavigation, refresh])

  const hydratePersistedUIState = useCallback(async (): Promise<void> => {
    useAppStore.getState().hydratePersistedUI(await window.api.ui.get(), 'sync')
  }, [])

  const mountedBeforeStartupWorktreeRefreshRef = useRef(!startupWorktreeRefreshCompleted)
  useEffect(() => {
    if (!startupWorktreeRefreshCompleted) {
      return
    }
    if (mountedBeforeStartupWorktreeRefreshRef.current) {
      // Why: App just supplied this mount's initial worktrees; a second full scan would duplicate every repo probe.
      mountedBeforeStartupWorktreeRefreshRef.current = false
      return
    }
    void fetchAllWorktrees()
  }, [fetchAllWorktrees, startupWorktreeRefreshCompleted])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    // Pause the relative-time clock while the window is hidden.
    return installWindowVisibilityInterval({
      run: () => setRelativeNow(Date.now()),
      intervalMs: 60 * 1000
    })
  }, [])

  useEffect(() => {
    const automationId = selected?.id ?? null
    if (!automationId) {
      setSelectedAutomationRuns({ automationId: null, runs: [] })
      return
    }
    let cancelled = false
    const target =
      pendingAutomationRunNavigation?.automationId === automationId &&
      pendingAutomationRunNavigation.hostId
        ? getAutomationTargetFromHostId(pendingAutomationRunNavigation.hostId)
        : selected
          ? getAutomationOwnerTarget(selected, automationHostTarget)
          : getAutomationListTarget(settings)
    void listAutomationRunsForTarget(target, automationId).then((nextRuns) => {
      if (!cancelled) {
        setSelectedAutomationRuns({ automationId, runs: nextRuns })
      }
    })
    return () => {
      cancelled = true
    }
  }, [automationHostTarget, pendingAutomationRunNavigation, selected, selected?.id, runs, settings])

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
      if (run.status !== 'dispatched' || !run.terminalPaneKey) {
        return false
      }
      if (inFlight.has(run.id)) {
        return false
      }
      const dispatchedAt = run.dispatchedAt ?? null
      if (dispatchedAt === null) {
        return false
      }
      return hasAutomationRunCompletionEvidence({
        run,
        dispatchedAt,
        agentStatusByPaneKey,
        retainedAgentsByPaneKey
      })
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
          terminalPaneKey: run.terminalPaneKey,
          terminalPtyId: run.terminalPtyId,
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

  useEffect(() => {
    if (
      !createOpen ||
      createTarget !== 'orca' ||
      draft.workspaceMode !== 'new_per_run' ||
      !draft.projectId
    ) {
      return
    }
    void loadAutomationYamlHooksForRepo(draft.projectId)
  }, [
    createOpen,
    createTarget,
    draft.projectId,
    draft.workspaceMode,
    loadAutomationYamlHooksForRepo
  ])

  useEffect(() => {
    if (!createOpen) {
      setupDecisionPolicyDefaultRef.current = undefined
      setupDecisionDefaultSignatureRef.current = null
      setupDecisionTouchedRef.current = false
      return
    }
    const nextDefault = getDraftSetupDecisionDefault(draft)
    const nextSignature = getDraftSetupDecisionDefaultSignature(draft)
    if (setupDecisionDefaultSignatureRef.current !== nextSignature) {
      setupDecisionDefaultSignatureRef.current = nextSignature
      setupDecisionTouchedRef.current = false
    }
    const previousDefault = setupDecisionPolicyDefaultRef.current
    setupDecisionPolicyDefaultRef.current = nextDefault
    const shouldApplyPolicyDefault =
      !setupDecisionTouchedRef.current &&
      (nextDefault === undefined ||
        draft.setupDecision === undefined ||
        draft.setupDecision === previousDefault)
    if (!shouldApplyPolicyDefault || draft.setupDecision === nextDefault) {
      return
    }
    setDraft((current) => ({ ...current, setupDecision: nextDefault }))
  }, [createOpen, draft, getDraftSetupDecisionDefault, getDraftSetupDecisionDefaultSignature])

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

  const handleCreateTargetChange = useCallback(
    (target: AutomationCreateTarget): void => {
      setCreateTarget(target)
      if (target === 'hermes') {
        const localRepos = getAutomationCreateRepos(repos, { kind: 'local' })
        setDraft((current) => {
          const currentRepo = repos.find((repo) => repo.id === current.projectId)
          const currentRepoIsLocal =
            currentRepo !== undefined &&
            localRepos.some(
              (repo) =>
                repo.id === currentRepo.id &&
                getRepoExecutionHostId(repo) === getRepoExecutionHostId(currentRepo)
            )
          const nextRepo = currentRepoIsLocal ? currentRepo : localRepos[0]
          const nextWorkspace = nextRepo
            ? getDefaultWorktree(worktreesByRepo[nextRepo.id] ?? [])
            : null
          return {
            ...current,
            agentId: 'hermes',
            projectId: nextRepo?.id ?? '',
            workspaceId: nextWorkspace?.id ?? '',
            workspaceMode: 'existing',
            setupDecision: undefined,
            reuseSession: false
          }
        })
      }
    },
    [repos, worktreesByRepo]
  )

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
      setupDecision: undefined,
      reuseSession: false,
      precheckCommand: '',
      precheckTimeoutSeconds: '60',
      preset: 'weekdays',
      time: AUTOMATION_DEFAULT_TIME,
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
      setupDecision: getAutomationSetupDecisionDraftValue({
        workspaceMode: latest.workspaceMode,
        persistedSetupDecision: latest.setupDecision
      }),
      reuseSession: latest.workspaceMode === 'existing' && latest.reuseSession,
      precheckCommand: latest.precheck?.command ?? '',
      precheckTimeoutSeconds: String(latest.precheck?.timeoutSeconds ?? 60),
      preset: schedule?.preset ?? (hasCustomSchedule ? 'custom' : 'weekdays'),
      time: schedule ? formatTimeInput(schedule.hour, schedule.minute) : AUTOMATION_DEFAULT_TIME,
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
            repo !== undefined && repoMatchesExternalAutomationTarget(repo, manager.target)
          return repoTargetMatches && job.workdir !== null && worktree.path === job.workdir
        }) ?? null
    const localRepos = getAutomationCreateRepos(repos, { kind: 'local' })
    const fallbackRepo =
      localRepos.find((repo) => repoMatchesExternalAutomationTarget(repo, manager.target)) ??
      localRepos[0] ??
      null
    const fallbackWorktree = fallbackRepo
      ? getDefaultWorktree(worktreesByRepo[fallbackRepo.id] ?? [])
      : null
    const projectId = targetWorktree?.repoId ?? fallbackRepo?.id ?? ''
    const workspaceId = targetWorktree?.id ?? fallbackWorktree?.id ?? ''
    const nextDraft: AutomationDraft = {
      name: job.name,
      prompt: job.prompt ?? job.promptPreview,
      agentId: 'hermes',
      projectId,
      workspaceMode: 'existing',
      workspaceId,
      baseBranch: '',
      setupDecision: undefined,
      reuseSession: false,
      precheckCommand: '',
      precheckTimeoutSeconds: '60',
      preset: hasCustomSchedule ? 'custom' : 'weekdays',
      time: AUTOMATION_DEFAULT_TIME,
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
      editingExternalTarget === null &&
      createTarget === 'orca' &&
      !canCreateAutomation
    ) {
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.destinationUnavailable',
          'The selected automation destination is not ready. Reconnect it and try again.'
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
          editingExternalTarget?.manager.target ?? getExternalAutomationTargetForRepo(repo)
        const repoTargetMatches = repoMatchesExternalAutomationTarget(repo, target)
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
      if (isOrcaForm && !dialogRepos.some((repo) => repo.id === draft.projectId)) {
        toast.error(
          translate(
            'auto.components.automations.AutomationsPage.destinationProjectUnavailable',
            'Choose a project owned by the selected automation destination.'
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
      let setupDecision = resolveAutomationSetupDecisionForSave({
        createTarget,
        workspaceMode: draft.workspaceMode,
        repoId: draft.projectId,
        repos,
        projectHostSetups,
        yamlHooks:
          createTarget === 'orca' && draft.workspaceMode === 'new_per_run'
            ? await loadAutomationYamlHooksForRepo(draft.projectId)
            : null,
        draftSetupDecision: draft.setupDecision
      })
      if (setupDecision === 'run') {
        const trustDecision = await ensureHooksConfirmed(
          useAppStore.getState(),
          draft.projectId,
          'setup'
        )
        if (trustDecision === 'skip') {
          setupDecision = 'skip'
        }
      }
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
        setupDecision,
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
          ? await updateAutomationForTarget(currentAutomation, updates, automationHostTarget)
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
            setupDecision,
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
    await updateAutomationForTarget(
      automation,
      { enabled: !automation.enabled },
      automationHostTarget
    )
    await refresh()
  }

  const deleteAutomation = async (automation: Automation): Promise<void> => {
    await deleteAutomationForTarget(automation, automationHostTarget)
    if (useAppStore.getState().selectedAutomationId === automation.id) {
      selectAutomationId(null)
      setIsDetailOpen(false)
      setSelectedAutomationRunPageId(null)
      setActivePaneTab('overview')
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
      automationHostTarget,
      sourceHostAvailability: automationSourceHostAvailabilityById.get(automation.id)
    })
    if (!availability.canRunNow) {
      toast.error(availability.message)
      return
    }
    await runAutomationNowForTarget(automation, automationHostTarget)
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
      await runAutomationNowForTarget(automation, automationHostTarget)
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
      // Why: full-page detail keeps selection when the deleted external was open;
      // without this, detail can fall through to an unrelated local automation.
      if (action === 'delete') {
        const deletedKey = getExternalAutomationKey(manager, job)
        if (selectedExternalKeyRef.current === deletedKey) {
          selectExternalKey(null)
          setIsDetailOpen(false)
          setActivePaneTab('overview')
        }
      }
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

  const openRunWorkspace = (run: AutomationRun): void => {
    const runWorktree = run.workspaceId ? (worktreeMap.get(run.workspaceId) ?? null) : null
    const store = useAppStore.getState()
    const openTabId = getAutomationRunOpenTabId(run)
    const terminalTabExists = openTabId ? Boolean(store.getTab(openTabId)) : false
    const currentLayout = openTabId ? store.terminalLayoutsByTabId[openTabId] : null
    const livePtyIds = openTabId ? (store.ptyIdsByTabId[openTabId] ?? []) : []
    const terminalTarget = resolveAutomationRunOpenTarget({
      run,
      terminalTabExists,
      currentLayout,
      livePtyIds
    })
    const runViewState = getAutomationRunViewState({
      run,
      workspaceExists: Boolean(runWorktree),
      terminalTargetExists: terminalTarget !== null
    })
    if (!run.workspaceId || !runWorktree || !runViewState.canOpen) {
      toast.error(runViewState.statusLabel)
      return
    }
    if (runViewState.availability === 'terminal' && !terminalTarget) {
      toast.error(runViewState.statusLabel)
      return
    }
    if (terminalTarget && currentLayout) {
      store.setTabLayout(
        terminalTarget.tabId,
        buildAutomationRunOpenLayout({
          target: terminalTarget,
          currentLayout
        })
      )
      if (activateAndRevealWorktree(run.workspaceId)) {
        store.setActiveTab(terminalTarget.tabId)
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

      // Why: fields that clear their own value on Escape consume this press;
      // blurring here would drop focus and let the next Escape close the page.
      if (target.dataset.escapeClearsValue === 'true') {
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

      // Why: detail is a full-page drill-in; step out of nested run views first,
      // then return to the table before leaving Automations.
      if (isDetailOpen) {
        event.preventDefault()
        if (selectedExternalRunPage) {
          setSelectedExternalRunPage(null)
          return
        }
        if (selectedAutomationRunPageId) {
          setSelectedAutomationRunPageId(null)
          return
        }
        setIsDetailOpen(false)
        setActivePaneTab('overview')
        return
      }

      event.preventDefault()
      closeAutomationsPage()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    closeAutomationsPage,
    createOpen,
    deleteTarget,
    externalDeleteTarget,
    isDetailOpen,
    selectedAutomationRunPageId,
    selectedExternalRunPage
  ])

  return (
    <main className="relative flex h-full min-h-0 flex-col bg-background pt-5 text-foreground md:pt-6">
      <header
        className="flex shrink-0 items-center px-3 pb-3 md:px-5"
        // Why: no stacked center titlebar on this page; keep the title clear of Windows/Linux window controls.
        style={
          {
            paddingRight: 'max(0.75rem, var(--window-controls-width, 0px))'
          } as React.CSSProperties
        }
      >
        <h1 className="truncate text-base font-semibold leading-8">
          {translate('auto.components.automations.AutomationsPage.77c2778945', 'Automations')}
        </h1>
      </header>

      <AutomationEditorDialog
        open={createOpen}
        isEditing={editingAutomationId !== null}
        isSaving={isSaving}
        canSave={canSaveDraft}
        isEditingExternal={editingExternalTarget !== null}
        createTarget={createTarget}
        repos={dialogRepos}
        projectHostSetups={projectHostSetups}
        automationYamlHooksByRepoKey={automationYamlHooksByRepoKey}
        getAutomationHooksCacheKey={getAutomationHooksCacheKey}
        repoMap={repoMap}
        worktrees={worktrees}
        settings={settings}
        draft={draft}
        onProjectChange={handleProjectChange}
        getRepoHostLabel={getAutomationRepoHostLabel}
        allowAddProject={!isOrcaForm || automationDialogTarget.kind === 'local'}
        onCreateTargetChange={handleCreateTargetChange}
        onOpenChange={setCreateOpen}
        onDraftChange={setDraft}
        onSetupDecisionTouched={markSetupDecisionTouched}
        onApplyTemplate={applyTemplateToDraft}
        onSave={() => void saveAutomation()}
      />

      <AutomationDeleteDialog
        deleteTarget={deleteTarget}
        dontAskDeleteAgain={dontAskDeleteAgain}
        confirmButtonRef={deleteConfirmButtonRef}
        onOpenChange={(open) => {
          if (open) {
            return
          }
          setDeleteTarget(null)
          setDontAskDeleteAgain(false)
        }}
        onDontAskAgainToggle={() => setDontAskDeleteAgain((prev) => !prev)}
        onCancel={() => {
          setDeleteTarget(null)
          setDontAskDeleteAgain(false)
        }}
        onConfirm={() => void confirmDeleteAutomation()}
      />

      <ExternalAutomationDeleteDialog
        externalDeleteTarget={externalDeleteTarget}
        confirmButtonRef={externalDeleteConfirmButtonRef}
        onOpenChange={(open) => {
          if (!open) {
            setExternalDeleteTarget(null)
          }
        }}
        onCancel={() => setExternalDeleteTarget(null)}
        onConfirm={() => void confirmDeleteExternalAutomation()}
      />

      {/* Why: empty list flashes templates before data arrives; keep layout stable on first load. */}
      {isLoading && !hasListItems ? (
        <AutomationsPageSkeleton />
      ) : isDetailOpen && (selected || selectedExternal) ? (
        <AutomationsDetailPane
          selected={selected}
          selectedExternal={selectedExternal}
          selectedExternalRunPage={selectedExternalRunPage}
          selectedAutomationRunPage={selectedAutomationRunPage}
          selectedRuns={selectedRuns}
          activePaneTab={activePaneTab}
          relativeNow={relativeNow}
          externalActionKey={externalActionKey}
          selectedRepoDisplayName={
            selectedRepo?.displayName ??
            translate('auto.components.automations.AutomationsPage.13118faadf', 'Unknown project')
          }
          selectedRepoDefaultBaseRef={selectedRepo?.worktreeBaseRef ?? null}
          selectedWorkspaceName={
            selected?.workspaceMode === 'new_per_run'
              ? translate(
                  'auto.components.automations.AutomationsPage.cd8397cc32',
                  'New workspace each run'
                )
              : (selectedWorktree?.displayName ??
                translate(
                  'auto.components.automations.AutomationsPage.missingWorkspace',
                  'Missing workspace'
                ))
          }
          hostLabelById={hostLabelById}
          selectedRunNowAvailability={selectedRunNowAvailability}
          selectedAutomationRunPageWorkspaceDisplay={selectedAutomationRunPageWorkspaceDisplay}
          selectedAutomationRunPageViewState={selectedAutomationRunPageViewState}
          canRerunSelectedAutomationRunPage={canRerunSelectedAutomationRunPage}
          isSelectedAutomationRunPageRerunPending={isSelectedAutomationRunPageRerunPending}
          worktreeMap={worktreeMap}
          fetchExternalAutomationRuns={fetchExternalAutomationRuns}
          onActivePaneTabChange={setActivePaneTab}
          onClearExternalRunPage={() => setSelectedExternalRunPage(null)}
          onClearAutomationRunPage={() => setSelectedAutomationRunPageId(null)}
          requestExternalAction={requestExternalAction}
          openExternalRunPage={openExternalRunPage}
          openEditExternalDialog={openEditExternalDialog}
          runNow={(automation) => void runNow(automation)}
          openEditDialog={(automation) => void openEditDialog(automation)}
          toggleAutomation={(automation) => void toggleAutomation(automation)}
          requestDeleteAutomation={requestDeleteAutomation}
          rerunAutomationRun={(automation, run) => void rerunAutomationRun(automation, run)}
          openRunWorkspace={openRunWorkspace}
          openAutomationRunPage={openAutomationRunPage}
          onBackToList={() => {
            setIsDetailOpen(false)
            setSelectedAutomationRunPageId(null)
            setSelectedExternalRunPage(null)
            setActivePaneTab('overview')
          }}
        />
      ) : (
        <AutomationsListPanel
          hasListItems={hasListItems}
          hasFilteredListItems={hasFilteredListItems}
          isListSearchActive={isListSearchActive}
          isListFilterActive={isListFilterActive}
          listSearchQuery={listSearchQuery}
          isListSearchQueryTooLarge={isListSearchQueryTooLarge}
          onListSearchQueryChange={setListSearchQuery}
          visibleItems={visibleItems}
          listFilter={listFilter}
          onListFilterChange={setListFilter}
          listSort={listSort}
          onListSort={(field) => setListSort((current) => nextAutomationListSort(current, field))}
          selectedId={selectedId}
          selectedExternalKey={selectedExternalKey}
          runs={runs}
          relativeNow={relativeNow}
          repoMap={repoMap}
          worktreeMap={worktreeMap}
          projectHostSetups={projectHostSetups}
          sshConnectionStates={sshConnectionStates}
          runtimeStatusByEnvironmentId={runtimeStatusByEnvironmentId}
          automationHostTarget={automationHostTarget}
          automationSourceHostAvailabilityById={automationSourceHostAvailabilityById}
          hostLabelById={hostLabelById}
          externalActionKey={externalActionKey}
          selectAutomationId={selectAutomationId}
          selectExternalKey={selectExternalKey}
          setActivePaneTab={setActivePaneTab}
          runNow={(automation) => void runNow(automation)}
          openEditDialog={(automation) => void openEditDialog(automation)}
          toggleAutomation={(automation) => void toggleAutomation(automation)}
          requestDeleteAutomation={requestDeleteAutomation}
          requestExternalAction={requestExternalAction}
          openEditExternalDialog={openEditExternalDialog}
          openCreateDialog={openCreateDialog}
          canCreateAutomation={canCreateAutomation}
          onOpenDetail={() => setIsDetailOpen(true)}
          onRefresh={() => void refresh()}
          isRefreshing={isLoading}
        />
      )}
    </main>
  )
}
