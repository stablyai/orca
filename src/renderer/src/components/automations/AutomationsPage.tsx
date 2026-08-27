/* eslint-disable max-lines -- Why: this page owns the automations list/detail
 * orchestration while the form, list, and detail presentation live in sibling files. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { filterEnabledTuiAgents, isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { useAppStore } from '@/store'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useRepoMap, useWorktreeMap } from '@/store/selectors'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type {
  Automation,
  AutomationCreateInput,
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager,
  ExternalAutomationRun,
  AutomationRun,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import {
  AUTOMATION_OWNER_CONFLICT_CODES,
  automationOwnerConflictMessage
} from '../../../../shared/automation-owner-conflict'
import {
  getLocalExecutionHostLabel,
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import type { Repo } from '../../../../shared/repo-types'
import { getWorktreePathBasenameFromId } from '../../../../shared/worktree/id'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildAutomationRrule,
  isValidAutomationCronSchedule,
  isValidAutomationSchedule
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
import { getAutomationRunWorkspaceDisplay } from './automation-run-workspace-display'
import {
  AutomationEditorDialog,
  type AutomationCreateTarget,
  type AutomationDraft
} from './AutomationEditorDialog'
import {
  getVisibleAutomationSetupDecision,
  resolveAutomationSetupDecisionForSave
} from './automation-setup-decision'
import type { AutomationTemplate } from './automation-templates'
import { getAutomationTargetAvailability } from './automation-target-availability'
import { buildAutomationRunContextForRepo } from './automation-run-context'
import { repoMatchesExternalAutomationTarget } from './automation-external-target-match'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import { useAutomationSourceHostAvailability } from './use-automation-source-host-availability'
import {
  useSelectedAutomationRunHistory,
  type SelectedAutomationRunHistoryOutcome
} from './use-selected-automation-run-history'

import {
  deleteAutomationForTarget,
  type AutomationHostTarget,
  getAutomationHostTargetFromKey,
  getAutomationHostTargetKey,
  getAutomationListTarget,
  getAutomationOwnerTarget,
  getAutomationTargetFromHostId,
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
  getDefaultWorktree,
  parseDraftTime
} from './automation-draft-model'
import type { AutomationPaneTab, SelectedExternalRunPage } from './automation-page-state'
import { isMissingExternalRunsApiError } from './external-automation-display'
import {
  externalAutomationActionKey,
  externalAutomationJobKey
} from './external-automation-scope-keys'
import { buildExternalAutomationListEntries } from './external-automation-list-entries'
import type { ExternalAutomationScope } from './external-automation-scope-client'
import { useAutomationListSearch } from './use-automation-list-search'
import {
  EMPTY_AUTOMATION_LIST_FILTER,
  filterAutomationListRows,
  filterExternalAutomationListEntries,
  type AutomationListFilter
} from './automation-list-view'
import {
  automationRepoForRow,
  automationWorktreeForRow,
  unscopedAutomationListRows,
  type AutomationListRow
} from './automation-list-row-identity'
import { AutomationDeleteDialog, ExternalAutomationDeleteDialog } from './AutomationDeleteDialogs'
import { AutomationsListPanel } from './AutomationsListPanel'
import { AutomationsDetailPane } from './AutomationsDetailPane'
import { AutomationsPageSkeleton } from './AutomationsPageSkeleton'
import type {
  AutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import type { AutomationDestination } from '../../../../shared/automation-owner-precondition'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import {
  capturedAutomationOwner,
  capturedAutomationOwnerKey,
  isAutomationActionEnabled,
  type AutomationRowAction
} from './automation-captured-owner'
import { useAutomationHostCatalog } from './use-automation-host-catalog'
import { useScopedExternalAutomations } from './use-scoped-external-automations'
import { externalAutomationScopeEntries } from './external-automation-scope-gating'
import { externalAutomationUncheckedNotice } from './external-automation-unchecked-hosts'
import {
  automationRuntimePairingRevision,
  groupReposByAutomationAuthority
} from './automation-authority-identity'
import {
  automationCreateHostOffered,
  automationCreateHostStableKey,
  resolveAutomationCreateDestination,
  revalidateAutomationCreateDestination,
  type AutomationCreateDestination
} from './automation-create-destination'
import { useAutomationCreateDestination } from './use-automation-create-destination'
import { persistSkipDeleteAutomationConfirm } from './automation-delete-confirm-preference'
import { buildAutomationEditDraft, buildExternalAutomationEditDraft } from './automation-edit-draft'
import { createAutomationAtDestination } from './automation-owner-action-runner'
import {
  dispatchAutomationDelete,
  dispatchAutomationReread,
  dispatchAutomationRunNow,
  dispatchAutomationUpdate,
  toDispatchResult,
  type AutomationActionNotice,
  type AutomationDispatchResult
} from './automation-row-action-dispatch'
import {
  automationRowCatalogRef,
  automationWriteChangeEvent
} from './automation-write-invalidation'
import { automationRowRecoveryHost } from './automation-notice-recovery-host'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationAuthorityChangeReason } from './automation-host-invalidation'
import { AutomationOwnerConflictNotice } from './AutomationOwnerConflictNotice'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { translate } from '@/i18n/i18n'
import { AUTOMATIONS_CHANGED_EVENT } from '@/lib/automations-changed-window-event'

const AGENTS = getAgentCatalog().map((agent) => agent.id)

const EMPTY_AUTOMATION_RUNS: readonly AutomationRun[] = []

/** Returns the same set when nothing was removed, so an unchanged catalog memo holds. */
function withoutKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!keys.has(key)) {
    return keys
  }
  const next = new Set(keys)
  next.delete(key)
  return next
}

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
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const settings = useAppStore((s) => s.settings)
  const selectedId = useAppStore((s) => s.selectedAutomationId)
  const setSelectedId = useAppStore((s) => s.setSelectedAutomationId)
  const pendingAutomationRunNavigation = useAppStore((s) => s.pendingAutomationRunNavigation)
  const setPendingAutomationRunNavigation = useAppStore((s) => s.setPendingAutomationRunNavigation)
  const repoMap = useRepoMap()
  const worktreeMap = useWorktreeMap()
  const repoForRow = useCallback(
    (row: AutomationListRow): Repo | undefined => automationRepoForRow(row, repos, repoMap),
    [repoMap, repos]
  )
  const worktreeForRow = useCallback(
    (
      row: AutomationListRow,
      repo: Repo | undefined,
      workspaceId: string | null | undefined = row.automation.workspaceId
    ): Worktree | undefined =>
      automationWorktreeForRow(row, worktreesByRepo, repo, worktreeMap, workspaceId),
    [worktreeMap, worktreesByRepo]
  )
  const enabledAgents = filterEnabledTuiAgents(AGENTS, settings?.disabledTuiAgents)
  const defaultAgent =
    settings?.defaultTuiAgent &&
    settings.defaultTuiAgent !== 'blank' &&
    isTuiAgentEnabled(settings.defaultTuiAgent, settings.disabledTuiAgents)
      ? settings.defaultTuiAgent
      : (enabledAgents[0] ?? AGENTS[0])

  const [automations, setAutomations] = useState<Automation[]>([])
  const [automationHostTargetKey, setAutomationHostTargetKey] = useState<string | null>(null)
  const [selectedAutomationRuns, setSelectedAutomationRuns] =
    useState<SelectedAutomationRunHistoryOutcome>({
      automationId: null,
      rowKey: null,
      ownerKey: null,
      runs: [],
      notice: null
    })
  // Bumped by the run-history Retry; the read is otherwise keyed only by the row.
  const [runHistoryReloadToken, setRunHistoryReloadToken] = useState(0)
  // Why a set of authority keys: a failed list is a fact about the authority that
  // answered, and the catalog needs it per authority to mark its hosts unloaded.
  const [failedAuthorityKeys, setFailedAuthorityKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  // Held with the host it was raised against: Reconnect and Update server act on
  // the row's own host, not on whatever the list happens to be scoped to.
  const [ownerAction, setOwnerAction] = useState<{
    notice: AutomationActionNotice
    host: AutomationHostCatalogEntry | null
  } | null>(null)
  // Separate from the page notice: while the editor is open it covers the page,
  // so a refusal posted there is a save that visibly did nothing at all.
  const [editorNotice, setEditorNotice] = useState<AutomationActionNotice | null>(null)
  const [externalActionKey, setExternalActionKey] = useState<string | null>(null)
  const [rerunRunIdsInFlight, setRerunRunIdsInFlight] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [listSearchQuery, setListSearchQuery] = useState('')
  const [listFilter, setListFilter] = useState<AutomationListFilter>(EMPTY_AUTOMATION_LIST_FILTER)
  const [createOpen, setCreateOpen] = useState(false)
  const [createTarget, setCreateTarget] = useState<AutomationCreateTarget>('orca')
  const [editingAutomationId, setEditingAutomationId] = useState<string | null>(null)
  // Held beside the id: a save fences on the row the user opened, and under All
  // hosts that id alone names two rows.
  const [editingRowKey, setEditingRowKey] = useState<string | null>(null)
  // Captured with the editor's selected project so an SSH re-registration while
  // the form is open cannot silently retarget the saved automation.
  const [editingDestination, setEditingDestination] = useState<{
    projectId: string
    destination: AutomationCreateDestination
  } | null>(null)
  const [relativeNow, setRelativeNow] = useState(Date.now())
  const [activePaneTab, setActivePaneTab] = useState<AutomationPaneTab>('overview')
  const [selectedAutomationRunPageId, setSelectedAutomationRunPageId] = useState<string | null>(
    null
  )
  // Held next to the store's automation id rather than in it: the id is what
  // other pages navigate by, and only this side knows which host's copy is shown.
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null)
  const [selectedExternalKey, setSelectedExternalKey] = useState<string | null>(null)
  const [selectedExternalRunPage, setSelectedExternalRunPage] =
    useState<SelectedExternalRunPage | null>(null)
  // Why: list is the primary surface; detail is a full-page drill-in, not a side pane.
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const selectedExternalKeyRef = useRef<string | null>(null)
  // Keep async refresh/delete handlers reading the latest selection without render-time mutation.
  useEffect(() => {
    selectedExternalKeyRef.current = selectedExternalKey
  }, [selectedExternalKey])
  const selectAutomationId = useCallback(
    (automationId: string | null): void => {
      setSelectedAutomationRunPageId(null)
      setSelectedRowKey(null)
      setSelectedId(automationId)
    },
    [setSelectedId]
  )
  const selectExternalKey = useCallback((externalKey: string | null): void => {
    setSelectedExternalRunPage(null)
    setSelectedExternalKey(externalKey)
  }, [])
  const [draftAtOpen, setDraftAtOpen] = useState<AutomationDraft | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AutomationListRow | null>(null)
  const [externalDeleteTarget, setExternalDeleteTarget] = useState<{
    manager: ExternalAutomationManager
    job: ExternalAutomationJob
    /** Captured with the row, so the confirmed delete cannot land on another host. */
    scope: ExternalAutomationScope
  } | null>(null)
  useContextualTour(
    'automations',
    !isLoading && !createOpen && !deleteTarget && !externalDeleteTarget,
    'automations_open'
  )
  const [editingExternalTarget, setEditingExternalTarget] = useState<{
    manager: ExternalAutomationManager
    job: ExternalAutomationJob
    // Captured from the row that opened the dialog: the manager ID alone cannot
    // name an authority, so a re-lookup could save to the wrong host.
    scope: ExternalAutomationScope
  } | null>(null)
  const [dontAskDeleteAgain, setDontAskDeleteAgain] = useState(false)
  const editRequestRef = useRef(0)
  const deleteConfirmButtonRef = useRef<HTMLButtonElement>(null)
  // Why: both dialogs stay mounted, so a shared ref would let one dialog's
  // unmount clear the focus target the other still needs.
  const externalDeleteConfirmButtonRef = useRef<HTMLButtonElement>(null)
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
  const draftRef = useRef(draft)
  draftRef.current = draft

  const hostCatalog = useAutomationHostCatalog({ failedAuthorityKeys })
  // Probing follows the selection, not the catalog: a Local selection must not
  // reach out to every SSH host the user happens to have registered.
  const externalScopeEntries = useMemo(
    () => externalAutomationScopeEntries(hostCatalog.entries, hostCatalog.resolution),
    [hostCatalog.entries, hostCatalog.resolution]
  )
  const scopedExternal = useScopedExternalAutomations({
    catalogEntries: hostCatalog.entries,
    scopeEntries: externalScopeEntries
  })
  // Held apart from the view object, which is a fresh literal each render and
  // would refetch the runs table on every render of this page.
  const fetchScopedExternalRuns = scopedExternal.fetchRuns
  // Why the cache wins once it has answered: only its rows carry the host each
  // record came from, which is what the picker, the groups, and every fenced
  // action key on. Until then the unscoped list is all the page has, and it has
  // no host to qualify its rows with.
  const unscopedRows = useMemo(() => unscopedAutomationListRows(automations), [automations])
  const visibleRows = hostCatalog.rows.answered ? hostCatalog.rows.rows : unscopedRows
  // Picking a row records both: the key names the host's copy, the id is what
  // the rest of the page (and other pages) still address the record by.
  const selectAutomationRow = useCallback(
    (rowKey: string | null): void => {
      const row = rowKey === null ? null : visibleRows.find((candidate) => candidate.key === rowKey)
      setSelectedAutomationRunPageId(null)
      setSelectedRowKey(row?.key ?? null)
      setSelectedId(row?.automation.id ?? null)
    },
    [setSelectedId, visibleRows]
  )
  const capturedAutomationOwners = hostCatalog.rows.capturedOwners
  const externalAutomationEntries = useMemo(
    () => buildExternalAutomationListEntries(scopedExternal.managers),
    [scopedExternal.managers]
  )
  // The status/last-run/agent menu narrows rows before search, so both compose.
  const attributeFilteredRows = useMemo(
    () => filterAutomationListRows(visibleRows, listFilter),
    [listFilter, visibleRows]
  )
  const attributeFilteredExternalEntries = useMemo(
    () => filterExternalAutomationListEntries(externalAutomationEntries, listFilter),
    [externalAutomationEntries, listFilter]
  )

  const selectedExternal =
    externalAutomationEntries.find((entry) => entry.key === selectedExternalKey) ??
    (visibleRows.length === 0 ? (externalAutomationEntries[0] ?? null) : null)
  // The row key decides which of two same-id rows is selected; the stored id
  // still decides which record, so a selection arriving from another page (which
  // only carries an id) still lands somewhere.
  const selectedRow =
    selectedExternal === null
      ? selectedId
        ? (visibleRows.find(
            (row) => row.key === selectedRowKey && row.automation.id === selectedId
          ) ??
          visibleRows.find((row) => row.automation.id === selectedId) ??
          null)
        : (visibleRows[0] ?? null)
      : null
  const selected = selectedRow?.automation ?? null
  useEffect(() => {
    if (!isDetailOpen || pendingAutomationRunNavigation) {
      return
    }
    const hasSelectedLocal = selectedRowKey
      ? visibleRows.some((row) => row.key === selectedRowKey)
      : selectedId !== null && selectedRow !== null
    const hasSelectedExternal =
      selectedExternalKey !== null &&
      externalAutomationEntries.some((entry) => entry.key === selectedExternalKey)
    if (hasSelectedLocal || hasSelectedExternal) {
      return
    }
    setIsDetailOpen(false)
    setSelectedAutomationRunPageId(null)
    setSelectedExternalRunPage(null)
    setActivePaneTab('overview')
  }, [
    externalAutomationEntries,
    isDetailOpen,
    pendingAutomationRunNavigation,
    selectedExternalKey,
    selectedId,
    selectedRow,
    selectedRowKey,
    visibleRows
  ])
  // The detail pane renders `selectedRow.automation`, so the record it echoes back
  // names no row; the page already holds the one the user is looking at.
  const onSelectedRow = (act: (row: AutomationListRow) => void): void => {
    if (selectedRow) {
      act(selectedRow)
    }
  }

  const {
    isListSearchQueryTooLarge,
    filteredRows,
    filteredExternalAutomationEntries,
    hasListItems,
    hasFilteredListItems,
    searchCounts
  } = useAutomationListSearch({
    listSearchQuery,
    rows: attributeFilteredRows,
    externalAutomationEntries: attributeFilteredExternalEntries,
    repoMap,
    worktreeMap,
    selectedRowKey: selectedRow?.key ?? null,
    selectedExternalKey,
    selectAutomationRow,
    selectExternalKey
  })
  const selectedAutomationRunsWithWorkspaceNames = useMemo(
    () =>
      selectedAutomationRuns.runs.map((run) => {
        if (!run.workspaceId || run.workspaceDisplayName?.trim()) {
          return run
        }
        const displayName =
          (selectedRow
            ? worktreeForRow(selectedRow, repoForRow(selectedRow), run.workspaceId)?.displayName
            : worktreeMap.get(run.workspaceId)?.displayName) ??
          workspaceNameCacheRef.current.get(run.workspaceId) ??
          getWorktreePathBasenameFromId(run.workspaceId)
        const trimmedDisplayName = displayName?.trim()
        return trimmedDisplayName ? { ...run, workspaceDisplayName: trimmedDisplayName } : run
      }),
    [repoForRow, selectedAutomationRuns.runs, selectedRow, worktreeForRow, worktreeMap]
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
  // Row-qualified *and* incarnation-qualified: the row key says whose copy the
  // history was read for, the owner key says whether that host is still the
  // incarnation that answered.
  const selectedRunsMatchSelection =
    selectedRow !== null &&
    selectedAutomationRuns.rowKey === selectedRow.key &&
    selectedAutomationRuns.ownerKey ===
      capturedAutomationOwnerKey(capturedAutomationOwner(capturedAutomationOwners, selectedRow.key))
  // Empty rather than another row's history while the scoped fetch is in flight:
  // the page no longer holds every run, and showing the previous row's is worse
  // than showing none.
  const selectedRunsSource = selectedRunsMatchSelection
    ? selectedAutomationRunsWithWorkspaceNames
    : EMPTY_AUTOMATION_RUNS
  // Why: an unanswered history is not an empty one, so the pane states the refusal instead.
  const selectedRunsNotice = selectedRunsMatchSelection ? selectedAutomationRuns.notice : null
  const selectedRuns = useMemo(
    () => (selected ? selectedRunsSource.filter((run) => run.automationId === selected.id) : []),
    [selected, selectedRunsSource]
  )
  const selectedAutomationRunPage = selectedAutomationRunPageId
    ? (selectedRuns.find((run) => run.id === selectedAutomationRunPageId) ?? null)
    : null
  const selectedRunWorktreeMap = useMemo(() => {
    if (!selectedRow) {
      return worktreeMap
    }
    const repo = repoForRow(selectedRow)
    return new Map(
      selectedRuns.flatMap((run) => {
        const worktree = worktreeForRow(selectedRow, repo, run.workspaceId)
        return worktree ? [[worktree.id, worktree] as const] : []
      })
    )
  }, [repoForRow, selectedRow, selectedRuns, worktreeForRow, worktreeMap])
  const worktrees = useMemo(
    () => worktreesByRepo[draft.projectId] ?? [],
    [draft.projectId, worktreesByRepo]
  )
  const automationHostTarget = useMemo(
    () => getAutomationHostTargetFromKey(automationHostTargetKey),
    [automationHostTargetKey]
  )
  // The authority behind the *selected host*, used for orphan actions and for
  // stating a create destination. Owned rows never read it: their owner already
  // names an authority. Under All hosts no host is selected, so this is the
  // desktop — the client's own authority, never a guess at which host is meant.
  const automationAuthority = useMemo((): AutomationAuthorityRef => {
    const selectedAuthority = hostCatalog.resolution.entry?.stableRef.authority
    if (selectedAuthority?.kind !== 'runtime') {
      return { kind: 'desktop' }
    }
    const environmentId = selectedAuthority.environmentId
    return {
      kind: 'runtime',
      environmentId,
      pairingRevision: automationRuntimePairingRevision(runtimeEnvironments, environmentId)
    }
  }, [hostCatalog.resolution.entry, runtimeEnvironments])
  // Scoped per owning authority: a repo ID is unique only inside one, so the
  // flat map cannot say whether *this* authority holds the project.
  const repoTables = useMemo(() => groupReposByAutomationAuthority(repos), [repos])
  const activeWorkspaceHostStableKey = useMemo(() => {
    const worktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null
    return worktree
      ? automationCreateHostStableKey(
          getWorktreeExecutionHostId(worktree, repoMap.get(worktree.repoId))
        )
      : null
  }, [activeWorktreeId, repoMap, worktreeMap])
  const createDestination = useAutomationCreateDestination({
    open: createOpen && editingAutomationId === null && createTarget === 'orca',
    catalog: hostCatalog.catalog,
    entries: hostCatalog.entries,
    // Non-null only for a concrete host filter, which constrains the destination.
    filterStableKey: hostCatalog.resolution.entry?.stableKey ?? null,
    activeWorkspaceStableKey: activeWorkspaceHostStableKey,
    repoTables,
    projects: repos
  })
  const editorProjects = createDestination.control.projects
  // The destination's own repo table decides project eligibility, so a runtime
  // destination refreshes its mirror the moment the dialog captures it —
  // otherwise a never-fetched host offers no projects at all.
  const createDestinationRuntimeEnvironmentId =
    createDestination.control.resolution.status === 'ready' &&
    createDestination.control.resolution.authority.kind === 'runtime'
      ? createDestination.control.resolution.authority.environmentId
      : null
  useEffect(() => {
    if (createDestinationRuntimeEnvironmentId) {
      void useAppStore
        .getState()
        .fetchRuntimeEnvironmentRepos(createDestinationRuntimeEnvironmentId)
    }
  }, [createDestinationRuntimeEnvironmentId])
  // A destination change can strand the chosen project on another host; leaving it
  // selected only defers the same refusal to submit.
  useEffect(() => {
    if (!createOpen || editingAutomationId !== null || createTarget !== 'orca') {
      return
    }
    setDraft((current) =>
      !current.projectId || editorProjects.some((project) => project.id === current.projectId)
        ? current
        : { ...current, projectId: '', workspaceId: '', baseBranch: '' }
    )
  }, [createOpen, createTarget, editingAutomationId, editorProjects])
  // The row's own host, from its captured owner. A page-level target cannot
  // speak for a list spanning authorities, and the legacy arm below it is only
  // ever reached by rows the desktop's unscoped list produced.
  const automationHostTargetForRowKey = useCallback(
    (rowKey: string | null): AutomationHostTarget | null => {
      const owner = capturedAutomationOwner(capturedAutomationOwners, rowKey).owner
      if (owner?.authority.kind === 'runtime') {
        return { kind: 'environment', environmentId: owner.authority.environmentId }
      }
      return owner ? { kind: 'local' } : automationHostTarget
    },
    [automationHostTarget, capturedAutomationOwners]
  )
  const automationHostTargetFor = useCallback(
    (row: AutomationListRow): AutomationHostTarget | null => automationHostTargetForRowKey(row.key),
    [automationHostTargetForRowKey]
  )
  const automationDispatchContext = useMemo(
    () => ({ capturedOwners: capturedAutomationOwners, authority: automationAuthority }),
    [automationAuthority, capturedAutomationOwners]
  )
  const rowRecoveryHost = useCallback(
    (rowKey: string | null): AutomationHostCatalogEntry | null =>
      automationRowRecoveryHost(
        hostCatalog.catalog,
        capturedAutomationOwner(capturedAutomationOwners, rowKey),
        automationAuthority
      ),
    [automationAuthority, capturedAutomationOwners, hostCatalog.catalog]
  )
  const reportOwnerAction = useCallback(
    (rowKey: string | null, notice: AutomationActionNotice | null): void => {
      setOwnerAction(notice ? { notice, host: rowRecoveryHost(rowKey) } : null)
    },
    [rowRecoveryHost]
  )
  // A create is refused by the destination the dialog captured, a save by the row
  // it addresses; neither is the host the list is filtered to.
  const editorRecoveryHost = useMemo((): AutomationHostCatalogEntry | null => {
    if (editingAutomationId !== null) {
      return rowRecoveryHost(editingRowKey)
    }
    const resolution = createDestination.control.resolution
    return resolution.status === 'ready' ? resolution.entry : null
  }, [createDestination.control.resolution, editingAutomationId, editingRowKey, rowRecoveryHost])
  const notifyAuthorityChange = hostCatalog.notifyAuthorityChange
  // The list renders the per-host cache, so a write is only visible once that
  // host is refetched. The authority publishes the same event, but a round trip
  // later — and it cannot name a host the cache has no entry for, which is
  // precisely the host a create lands on.
  const invalidateWrittenHost = useCallback(
    (ref: StableAutomationCatalogRef | null, reason: AutomationAuthorityChangeReason): void => {
      notifyAuthorityChange(automationWriteChangeEvent(ref, automationAuthority, reason))
    },
    [automationAuthority, notifyAuthorityChange]
  )
  const invalidateRowHost = useCallback(
    (rowKey: string | null, reason: AutomationAuthorityChangeReason): void => {
      const captured = capturedAutomationOwner(capturedAutomationOwners, rowKey)
      invalidateWrittenHost(automationRowCatalogRef(captured, automationAuthority), reason)
    },
    [automationAuthority, capturedAutomationOwners, invalidateWrittenHost]
  )
  const isAutomationRowActionEnabled = useCallback(
    (row: AutomationListRow, action: AutomationRowAction): boolean =>
      isAutomationActionEnabled(capturedAutomationOwner(capturedAutomationOwners, row.key), action),
    [capturedAutomationOwners]
  )
  const externalManagersUncheckedNotice = useMemo(
    () => externalAutomationUncheckedNotice(scopedExternal.failures, hostCatalog.entries),
    [scopedExternal.failures, hostCatalog.entries]
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
    if (
      selectedAutomationRuns.notice &&
      selectedAutomationRuns.automationId === pending.automationId
    ) {
      // The host refused the history: the runs pane states that and offers its own
      // recovery, so the navigation must not sit pending waiting on runs never coming.
      setIsDetailOpen(true)
      setActivePaneTab('runs')
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
    selectedAutomationRuns.notice,
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
    ? selectedRow
      ? (worktreeForRow(
          selectedRow,
          repoForRow(selectedRow),
          selectedAutomationRunPage.workspaceId
        ) ?? null)
      : (worktreeMap.get(selectedAutomationRunPage.workspaceId) ?? null)
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
  const automationSourceHostAvailabilityByRowKey = useAutomationSourceHostAvailability(visibleRows)
  const selectedRepo = selectedRow ? (repoForRow(selectedRow) ?? null) : null
  const selectedWorktree =
    selectedRow && selected?.workspaceId
      ? (worktreeForRow(selectedRow, selectedRepo ?? undefined) ?? null)
      : null
  const selectedRunNowAvailability = selectedRow
    ? getAutomationTargetAvailability({
        automation: selectedRow.automation,
        repo: selectedRepo,
        workspace: selectedWorktree,
        projectHostSetups,
        sshConnectionStates,
        runtimeStatusByEnvironmentId,
        automationHostTarget: automationHostTargetFor(selectedRow),
        sourceHostAvailability: automationSourceHostAvailabilityByRowKey.get(selectedRow.key)
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
    const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null
    const activeRepo = activeWorktree ? (repoMap.get(activeWorktree.repoId) ?? null) : null
    // The stated destination decides which projects exist for this draft, so an
    // active workspace on another host is not a candidate here.
    const eligibleActiveRepo =
      activeRepo && editorProjects.some((project) => project.id === activeRepo.id)
        ? activeRepo
        : null
    const fallbackRepo = eligibleActiveRepo ?? editorProjects[0] ?? null
    const fallbackWorktrees = fallbackRepo ? (worktreesByRepo[fallbackRepo.id] ?? []) : []
    // Why: automation-created workspaces can be active; new automations should start from
    // the repo's stable main worktree unless the user explicitly chooses otherwise.
    const targetWorktree =
      getDefaultWorktree(fallbackWorktrees) ??
      (activeWorktree && activeWorktree.repoId === fallbackRepo?.id ? activeWorktree : null)
    const targetProjectId = fallbackRepo?.id ?? targetWorktree?.repoId ?? ''
    return {
      projectId: targetProjectId,
      workspaceId: targetWorktree?.id ?? ''
    }
  }, [activeWorktreeId, editorProjects, repoMap, worktreeMap, worktreesByRepo])

  // Gated on what the picker offers, not on eligibility: with every offered
  // host ineligible (e.g. all pre-host-scoping servers), the dialog is where
  // the repair is stated, so the button must still open it.
  const canCreateAutomation = hostCatalog.entries.some(automationCreateHostOffered)
  // The edited row's own captured owner names the host, not the ambient list
  // target: a remote row need not appear in `automations` at all, and looking it
  // up by id there would answer with whichever authority the page last listed.
  // An uncaptured row resolves to the same host its save addresses.
  const editingRow = editingRowKey
    ? (visibleRows.find((row) => row.key === editingRowKey) ?? null)
    : null
  const editingRowCapturedOwner = capturedAutomationOwner(
    capturedAutomationOwners,
    editingRowKey
  ).owner
  const automationDialogTarget = ((): AutomationHostTarget => {
    if (editingAutomationId === null) {
      return getAutomationListTarget(settings)
    }
    // Uncaptured: the host the legacy save addresses, so a runtime row the
    // desktop list produced stops offering desktop projects.
    if (editingRow && !editingRowCapturedOwner) {
      return getAutomationOwnerTarget(editingRow.automation, automationHostTarget)
    }
    return (
      automationHostTargetForRowKey(editingRowKey) ??
      getAutomationTargetFromHostId(editingRow?.automation.runContext?.hostId)
    )
  })()
  const isOrcaForm = createTarget === 'orca' && editingExternalTarget === null
  const dialogRepos = isOrcaForm
    ? editingAutomationId !== null
      ? getAutomationCreateRepos(repos, automationDialogTarget)
      : editorProjects
    : getAutomationCreateRepos(repos, { kind: 'local' })

  const destinationForProject = useCallback(
    (projectId: string): AutomationCreateDestination | null => {
      const runContext = buildAutomationRunContextForRepo({
        repoId: projectId,
        repos,
        projectHostSetups
      })
      if (!runContext) {
        return null
      }
      const stableKey = automationCreateHostStableKey(runContext.hostId)
      const entry = stableKey
        ? hostCatalog.entries.find((candidate) => candidate.stableKey === stableKey)
        : undefined
      const resolved = resolveAutomationCreateDestination(entry)
      return resolved.status === 'ready' ? resolved : null
    },
    [hostCatalog.entries, projectHostSetups, repos]
  )

  const reloadExternalManagers = scopedExternal.reload

  const refresh = useCallback(
    async (options?: { awaitExternalManagers?: boolean }) => {
      setIsLoading(true)
      const pendingNavigation = useAppStore.getState().pendingAutomationRunNavigation
      // The desktop unless navigation named a host: this arm exists for rows the
      // per-host reads have not answered for, and the client's own authority is
      // the only one it can address without guessing which server is meant.
      const automationHostTarget: AutomationHostTarget = pendingNavigation
        ? getAutomationTargetFromHostId(pendingNavigation.hostId)
        : { kind: 'local' }
      const authorityKey = automationAuthorityCatalogKey(
        automationHostTarget.kind === 'environment'
          ? { kind: 'runtime', environmentId: automationHostTarget.environmentId }
          : { kind: 'desktop' }
      )
      // Managers are per host and failures are per provider: the probe settles
      // into its own state on its own time, and must neither fail the automation
      // list nor keep the list loading while a slow provider answers. An explicit
      // external mutation opts in below, so the row set it re-reads reflects the
      // write before its success toast lands.
      const managersSettled = reloadExternalManagers().catch(() => undefined)
      try {
        const nextAutomations = await listAutomationsForTarget(automationHostTarget)
        // Selection and run history are deliberately not written here: this call
        // addressed one authority, and the selected row may belong to another.
        setAutomations(nextAutomations)
        setAutomationHostTargetKey(getAutomationHostTargetKey(automationHostTarget))
        setFailedAuthorityKeys((current) => withoutKey(current, authorityKey))
      } catch {
        // Why not a toast and not a rethrow: the list keeps whatever it had, and
        // the host's own status row is where the failure and its Retry belong.
        setFailedAuthorityKeys((current) => new Set(current).add(authorityKey))
      } finally {
        setIsLoading(false)
      }
      if (options?.awaitExternalManagers) {
        await managersSettled
      }
    },
    [reloadExternalManagers]
  )

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

  useSelectedAutomationRunHistory({
    selected: selectedRow,
    context: automationDispatchContext,
    legacyTarget: automationHostTargetFor,
    navigation: pendingAutomationRunNavigation,
    reloadToken: runHistoryReloadToken,
    onSettled: setSelectedAutomationRuns
  })

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
    setEditingDestination(null)
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

  const openEditDialog = async (row: AutomationListRow): Promise<void> => {
    const requestId = (editRequestRef.current += 1)
    setEditingExternalTarget(null)
    setCreateTarget('orca')
    const automationId = row.automation.id
    // Why: hydrate inside the row's own captured scope, not from whatever the
    // ambient authority happens to hold under the same automation ID.
    const reread = await dispatchAutomationReread(
      automationDispatchContext,
      { rowKey: row.key, automationId },
      async () =>
        (await listAutomationsForTarget({ kind: 'local' })).find(
          (entry) => entry.id === automationId
        ) ?? null
    )
    if (!reread.ok && reread.notice.severity === 'owner') {
      reportOwnerAction(row.key, reread.notice)
      return
    }
    // A failed re-read still opens the form on the copy already on screen.
    const latest = (reread.ok ? reread.value : null) ?? row.automation
    if (requestId !== editRequestRef.current) {
      return
    }
    setEditingAutomationId(latest.id)
    setEditingRowKey(row.key)
    const initialDestination = destinationForProject(latest.projectId)
    setEditingDestination(
      initialDestination ? { projectId: latest.projectId, destination: initialDestination } : null
    )
    const nextDraft = buildAutomationEditDraft(latest)
    setDraft(nextDraft)
    setDraftAtOpen(nextDraft)
    setCreateOpen(true)
  }

  const openEditExternalDialog = (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    scope: ExternalAutomationScope
  ): void => {
    editRequestRef.current += 1
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
    const nextDraft = buildExternalAutomationEditDraft(job, { projectId, workspaceId })
    setEditingAutomationId(null)
    setEditingRowKey(null)
    setEditingDestination(null)
    setEditingExternalTarget({ manager, job, scope })
    setCreateTarget('hermes')
    setDraft(nextDraft)
    setDraftAtOpen(nextDraft)
    setCreateOpen(true)
  }

  const handleProjectChange = useCallback(
    (projectId: string): void => {
      const currentWorktrees = worktreesByRepo[projectId] ?? []
      const currentDefaultWorktree = getDefaultWorktree(currentWorktrees)
      if (editingAutomationId !== null) {
        const destination = destinationForProject(projectId)
        setEditingDestination(destination ? { projectId, destination } : null)
      }
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
    [destinationForProject, editingAutomationId, fetchWorktrees, worktreesByRepo]
  )

  const handleDraftChange = useCallback(
    (updater: (current: AutomationDraft) => AutomationDraft): void => {
      const current = draftRef.current
      const next = updater(current)
      draftRef.current = next
      setDraft(next)
      if (
        editingAutomationId !== null &&
        (next.projectId !== current.projectId || next.workspaceId !== current.workspaceId)
      ) {
        const destination = destinationForProject(next.projectId)
        setEditingDestination(destination ? { projectId: next.projectId, destination } : null)
      }
    },
    [destinationForProject, editingAutomationId]
  )

  const saveAutomation = async (): Promise<void> => {
    setEditorNotice(null)
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
        // The scope the manager was listed under, never one re-derived from the
        // repo at save time — that is how an edit lands on the wrong host.
        const scope = editingExternalTarget
          ? editingExternalTarget.scope
          : scopedExternal.createScope(repo.connectionId ?? null)
        const repoTargetMatches =
          scope?.owner.selector.kind === 'ssh'
            ? repo.connectionId === scope.owner.selector.targetId
            : !repo.connectionId
        if (!scope || !repoTargetMatches) {
          toast.error(
            translate(
              'auto.components.automations.AutomationsPage.e431bb85d4',
              'Choose a workspace on the same host as this Hermes automation.'
            )
          )
          return
        }
        await scopedExternal.saveExternalAutomation(
          scope,
          {
            name: draft.name,
            prompt: draft.prompt,
            schedule: buildHermesCronSchedule(draft),
            workdir: selectedWorktree.path
          },
          editingExternalTarget?.job.id ?? null
        )
        if (!editingExternalTarget) {
          useAppStore.getState().recordFeatureInteraction('automation-created')
        }
        await refresh({ awaitExternalManagers: true })
        setCreateOpen(false)
        setEditingExternalTarget(null)
        // Same helper and same captured scope the row's key was built from, so the
        // edited automation stays selected instead of falling back to the first row.
        selectExternalKey(
          editingExternalTarget
            ? externalAutomationJobKey(editingExternalTarget.scope, editingExternalTarget.job.id)
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
      if (
        editingAutomationId !== null &&
        isOrcaForm &&
        !dialogRepos.some((repo) => repo.id === draft.projectId)
      ) {
        toast.error(
          translate(
            'auto.components.automations.AutomationsPage.destinationProjectUnavailable',
            'Choose a project owned by the selected automation destination.'
          )
        )
        return
      }
      // Refused here, before the side-effectful steps below (hooks load, trust
      // prompt): the user must not answer a trust dialog for a create that the
      // destination was always going to reject. `createDraftAutomation` checks
      // again after those awaits, which is the fence that actually gates the send.
      if (editingAutomationId === null) {
        const earlyDestination = createDestination.check(draft.projectId)
        if (!earlyDestination.ok) {
          setEditorNotice(earlyDestination.notice)
          return
        }
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
        // Why: the conflict check reads the row's own scope, and the legacy read
        // under it addresses the desktop rather than whichever host was ambient.
        const reread = await dispatchAutomationReread(
          automationDispatchContext,
          { rowKey: editingRowKey ?? '', automationId: editingAutomationId },
          async () =>
            (await listAutomationsForTarget(automationHostTarget ?? { kind: 'local' })).find(
              (automation) => automation.id === editingAutomationId
            ) ?? null
        )
        if (!reread.ok && reread.notice.severity === 'owner') {
          setEditorNotice(reread.notice)
          return
        }
        currentAutomation = (reread.ok ? reread.value : null) ?? currentAutomation
      }
      let editDestination: AutomationDestination | undefined
      const destinationChanged =
        currentAutomation &&
        (currentAutomation.projectId !== draft.projectId ||
          currentAutomation.workspaceId !== (draft.workspaceId || null) ||
          currentAutomation.workspaceMode !== draft.workspaceMode)
      if (editingAutomationId && currentAutomation && destinationChanged) {
        if (!editingDestination || editingDestination.projectId !== draft.projectId) {
          setEditorNotice({
            message: translate(
              'auto.components.automations.createDestination.unavailable',
              'Choose an available project on this host before saving.'
            ),
            recovery: 'retry',
            severity: 'owner'
          })
          return
        }
        const revalidated = revalidateAutomationCreateDestination(
          editingDestination.destination,
          hostCatalog.entries
        )
        if (revalidated.status === 'stale') {
          setEditorNotice({
            message: translate(
              'auto.components.automations.createDestination.stale',
              '{host} changed while this form was open. Choose the project again before saving.'
            ).replace('{host}', revalidated.entry.label),
            recovery: 'retry',
            severity: 'owner'
          })
          return
        }
        if (revalidated.status !== 'ready') {
          setEditorNotice({
            message: translate(
              'auto.components.automations.createDestination.unavailable',
              'Choose an available project on this host before saving.'
            ),
            recovery: 'retry',
            severity: 'owner'
          })
          return
        }
        editDestination = revalidated.destination
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
      const editSource = currentAutomation
      const saved = editingAutomationId
        ? await dispatchAutomationUpdate(
            automationDispatchContext,
            { rowKey: editingRowKey ?? '', automationId: editingAutomationId },
            updates,
            () => {
              // Nothing names a host: no captured owner and no record to read one
              // from, so the save is refused rather than sent unfenced.
              if (!editSource) {
                throw new Error(
                  automationOwnerConflictMessage(AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged)
                )
              }
              return updateAutomationForTarget(editSource, updates, automationHostTarget)
            },
            'save',
            editDestination
          )
        : await createDraftAutomation({
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
      if (!saved.ok) {
        setEditorNotice(saved.notice)
        return
      }
      const automation = saved.value
      // Create invalidates its stated destination inside `createDraftAutomation`,
      // which is the only place that still holds it.
      if (editingAutomationId) {
        invalidateRowHost(editingRowKey, 'definition')
      } else {
        await hydratePersistedUIState()
      }
      setAutomations((current) => {
        const next = current.filter((entry) => entry.id !== automation.id)
        return [...next, automation].sort((left, right) => left.name.localeCompare(right.name))
      })
      setDraft((current) => ({ ...current, name: '', prompt: '' }))
      await refresh()
      if (editingAutomationId && editingRowKey) {
        setSelectedAutomationRunPageId(null)
        setSelectedRowKey(editingRowKey)
        setSelectedId(automation.id)
      } else {
        selectAutomationId(automation.id)
      }
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

  /** Creation states its destination and re-checks it at submit; it never infers one. */
  const createDraftAutomation = async (
    input: AutomationCreateInput
  ): Promise<AutomationDispatchResult<Automation>> => {
    const checked = createDestination.check(input.projectId)
    if (!checked.ok) {
      return { ok: false, notice: checked.notice }
    }
    const result = toDispatchResult(
      await createAutomationAtDestination(
        checked.destination.authority,
        input,
        checked.destination.destination
      )
    )
    if (result.ok) {
      invalidateWrittenHost(checked.destination.entry.stableRef, 'definition')
    }
    return result
  }

  const toggleAutomation = async (row: AutomationListRow): Promise<void> => {
    const automation = row.automation
    const result = await dispatchAutomationUpdate(
      automationDispatchContext,
      { rowKey: row.key, automationId: automation.id },
      { enabled: !automation.enabled },
      () =>
        updateAutomationForTarget(
          automation,
          { enabled: !automation.enabled },
          automationHostTargetFor(row)
        )
    )
    reportOwnerAction(row.key, result.ok ? null : result.notice)
    if (result.ok) {
      invalidateRowHost(row.key, 'definition')
    }
    await refresh()
  }

  const deleteAutomation = async (row: AutomationListRow): Promise<void> => {
    const automation = row.automation
    const result = await dispatchAutomationDelete(
      automationDispatchContext,
      { rowKey: row.key, automationId: automation.id },
      () => deleteAutomationForTarget(automation, automationHostTargetFor(row))
    )
    reportOwnerAction(row.key, result.ok ? null : result.notice)
    if (result.ok) {
      if (selectedRowKey === row.key) {
        selectAutomationId(null)
        setIsDetailOpen(false)
        setSelectedAutomationRunPageId(null)
        setActivePaneTab('overview')
      }
      invalidateRowHost(row.key, 'definition')
    }
    await refresh()
  }

  const persistDeleteAutomationPreference = (): void =>
    persistSkipDeleteAutomationConfirm({ updateSettings, openSettingsPage, openSettingsTarget })

  const requestDeleteAutomation = (row: AutomationListRow): void => {
    if (settings?.skipDeleteAutomationConfirm) {
      void deleteAutomation(row)
      return
    }
    setDontAskDeleteAgain(false)
    setDeleteTarget(row)
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

  const runNow = async (row: AutomationListRow): Promise<void> => {
    const automation = row.automation
    const repo = repoForRow(row) ?? null
    const workspace = automation.workspaceId
      ? (worktreeForRow(row, repo ?? undefined) ?? null)
      : null
    const rowHostTarget = automationHostTargetFor(row)
    const availability = getAutomationTargetAvailability({
      automation,
      repo,
      workspace,
      projectHostSetups,
      sshConnectionStates,
      runtimeStatusByEnvironmentId,
      automationHostTarget: rowHostTarget,
      sourceHostAvailability: automationSourceHostAvailabilityByRowKey.get(row.key)
    })
    if (!availability.canRunNow) {
      toast.error(availability.message)
      return
    }
    const result = await dispatchAutomationRunNow(
      automationDispatchContext,
      { rowKey: row.key, automationId: automation.id },
      () => runAutomationNowForTarget(automation, rowHostTarget)
    )
    reportOwnerAction(row.key, result.ok ? null : result.notice)
    if (!result.ok) {
      return
    }
    useAppStore.getState().recordFeatureInteraction('automation-run')
    // A run rewrites this host's run history and its next-run projection, and the
    // list renders that host's cache — `refresh()` alone only feeds the pre-catalog
    // `automations`, which is no longer what is on screen.
    invalidateRowHost(row.key, 'run')
    await hydratePersistedUIState()
    await refresh()
    toast.message(
      translate('auto.components.automations.AutomationsPage.a1bdb57008', 'Automation run queued.')
    )
  }

  const rerunAutomationRun = async (row: AutomationListRow, run: AutomationRun): Promise<void> => {
    const runId = run.id
    if (rerunRunIdsInFlightRef.current.has(runId)) {
      return
    }
    const pendingStartedAt = Date.now()
    rerunRunIdsInFlightRef.current.add(runId)
    setRerunRunIdsInFlight(new Set(rerunRunIdsInFlightRef.current))
    try {
      const result = await dispatchAutomationRunNow(
        automationDispatchContext,
        { rowKey: row.key, automationId: row.automation.id },
        () => runAutomationNowForTarget(row.automation, automationHostTargetFor(row))
      )
      reportOwnerAction(row.key, result.ok ? null : result.notice)
      if (!result.ok) {
        await refresh()
        return
      }
      invalidateRowHost(row.key, 'run')
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
    scope: ExternalAutomationScope,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction
  ): Promise<void> => {
    // Keyed by the scope the row was discovered under — the same one the call
    // below routes to — so two hosts running the same provider can neither
    // disable each other's buttons nor receive each other's delete.
    setExternalActionKey(externalAutomationActionKey(scope, job.id, action))
    try {
      await scopedExternal.runExternalAction(scope, job.id, action)
      if (action === 'run') {
        useAppStore.getState().recordFeatureInteraction('automation-run')
      }
      await refresh({ awaitExternalManagers: true })
      // Why: full-page detail keeps selection when the deleted external was open;
      // without this, detail can fall through to an unrelated local automation.
      if (action === 'delete') {
        const deletedKey = externalAutomationJobKey(scope, job.id)
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
    async ({ scope, job, page, pageSize }) => {
      try {
        const result = await fetchScopedExternalRuns(scope, job, page, pageSize)
        return { runs: [...result.runs], totalCount: result.totalCount }
      } catch (error) {
        if (isMissingExternalRunsApiError(error)) {
          // An old host with no runs endpoint still has the runs the job carried.
          return {
            runs: job.runs.slice(page * pageSize, page * pageSize + pageSize),
            totalCount: job.runCount
          }
        }
        throw error
      }
    },
    [fetchScopedExternalRuns]
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
    action: ExternalAutomationAction,
    scope: ExternalAutomationScope
  ): void => {
    if (action === 'delete') {
      setExternalDeleteTarget({ manager, job, scope })
      return
    }
    void runExternalAction(scope, job, action)
  }

  const confirmDeleteExternalAutomation = async (): Promise<void> => {
    if (!externalDeleteTarget) {
      return
    }
    const target = externalDeleteTarget
    setExternalDeleteTarget(null)
    // The scope the confirmed row was listed under, not one re-derived after the
    // dialog opened: a delete is the action least able to survive a wrong host.
    await runExternalAction(target.scope, target.job, 'delete')
  }

  const openRunWorkspace = (run: AutomationRun): void => {
    const runWorktree =
      run.workspaceId && selectedRow
        ? (worktreeForRow(selectedRow, repoForRow(selectedRow), run.workspaceId) ?? null)
        : null
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

      <AutomationOwnerConflictNotice
        notice={ownerAction?.notice ?? null}
        className="mx-4 mb-2"
        onRecover={(action) => {
          const host = ownerAction?.host ?? null
          setOwnerAction(null)
          hostCatalog.recover(action, host)
          if (action === 'retry') {
            void refresh()
          }
        }}
        onDismiss={() => setOwnerAction(null)}
      />

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
        createDestination={createDestination.control}
        notice={editorNotice}
        onNoticeRecover={(action) => {
          setEditorNotice(null)
          hostCatalog.recover(action, editorRecoveryHost)
          if (action === 'retry') {
            void refresh()
          }
        }}
        onNoticeDismiss={() => setEditorNotice(null)}
        onProjectChange={handleProjectChange}
        getRepoHostLabel={getAutomationRepoHostLabel}
        allowAddProject={!isOrcaForm || automationDialogTarget.kind === 'local'}
        onCreateTargetChange={handleCreateTargetChange}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) {
            setEditorNotice(null)
          }
        }}
        onDraftChange={handleDraftChange}
        onSetupDecisionTouched={markSetupDecisionTouched}
        onApplyTemplate={applyTemplateToDraft}
        onSave={() => void saveAutomation()}
      />

      <AutomationDeleteDialog
        deleteTarget={deleteTarget?.automation ?? null}
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
          selectedRunsNotice={selectedRunsNotice}
          recoverSelectedRuns={(action) => {
            // Reconnect/Update server act on the selected row's own host; the
            // re-ask is what brings this automation's history back either way.
            hostCatalog.recover(action, rowRecoveryHost(selectedRowKey))
            setSelectedAutomationRuns((current) => ({ ...current, notice: null }))
            setRunHistoryReloadToken((token) => token + 1)
          }}
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
          worktreeMap={selectedRunWorktreeMap}
          fetchExternalAutomationRuns={fetchExternalAutomationRuns}
          onActivePaneTabChange={setActivePaneTab}
          onClearExternalRunPage={() => setSelectedExternalRunPage(null)}
          onClearAutomationRunPage={() => setSelectedAutomationRunPageId(null)}
          requestExternalAction={requestExternalAction}
          openExternalRunPage={openExternalRunPage}
          openEditExternalDialog={openEditExternalDialog}
          runNow={() => onSelectedRow(runNow)}
          openEditDialog={() => onSelectedRow(openEditDialog)}
          toggleAutomation={() => onSelectedRow(toggleAutomation)}
          requestDeleteAutomation={() => onSelectedRow(requestDeleteAutomation)}
          rerunAutomationRun={(_automation, run) =>
            onSelectedRow((row) => rerunAutomationRun(row, run))
          }
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
          listSearchQuery={listSearchQuery}
          isListSearchQueryTooLarge={isListSearchQueryTooLarge}
          onListSearchQueryChange={setListSearchQuery}
          listFilter={listFilter}
          onListFilterChange={(next) => {
            setListFilter(next)
            // Host narrowing is row-side now; a leftover single-host query scope
            // would hide the very rows the menu is asking for.
            if (
              (next.hostStableKeys?.length ?? 0) > 0 &&
              hostCatalog.resolution.effective.kind !== 'all'
            ) {
              hostCatalog.selectHost({ kind: 'all' })
            }
          }}
          // Pre-filter count, so "no match" is distinguishable from an empty host.
          searchCounts={{
            ...searchCounts,
            hostRowCount: visibleRows.length + externalAutomationEntries.length
          }}
          hostCatalog={hostCatalog}
          externalManagersUncheckedNotice={externalManagersUncheckedNotice}
          onSelectHost={hostCatalog.selectHost}
          onRecoverHost={(action, entry) => {
            hostCatalog.recover(action, entry)
            if (action === 'retry') {
              void refresh()
            }
          }}
          isActionEnabled={isAutomationRowActionEnabled}
          filteredRows={filteredRows}
          filteredExternalAutomationEntries={filteredExternalAutomationEntries}
          selectedRowKey={selectedRowKey}
          selectedExternalKey={selectedExternalKey}
          selectedExternal={selectedExternal}
          relativeNow={relativeNow}
          repoMap={repoMap}
          worktreeMap={worktreeMap}
          repoForRow={repoForRow}
          worktreeForRow={worktreeForRow}
          projectHostSetups={projectHostSetups}
          sshConnectionStates={sshConnectionStates}
          runtimeStatusByEnvironmentId={runtimeStatusByEnvironmentId}
          hostTargetFor={automationHostTargetFor}
          automationSourceHostAvailabilityByRowKey={automationSourceHostAvailabilityByRowKey}
          hostLabelById={hostLabelById}
          externalActionKey={externalActionKey}
          selectAutomationRow={selectAutomationRow}
          selectExternalKey={selectExternalKey}
          setActivePaneTab={setActivePaneTab}
          runNow={(row) => void runNow(row)}
          openEditDialog={(row) => void openEditDialog(row)}
          toggleAutomation={(row) => void toggleAutomation(row)}
          requestDeleteAutomation={requestDeleteAutomation}
          requestExternalAction={requestExternalAction}
          openEditExternalDialog={openEditExternalDialog}
          openCreateDialog={openCreateDialog}
          canCreateAutomation={canCreateAutomation}
          onOpenDetail={() => setIsDetailOpen(true)}
          onRefresh={() => {
            hostCatalog.refreshHosts()
            void refresh()
          }}
          isRefreshing={isLoading}
        />
      )}
    </main>
  )
}
