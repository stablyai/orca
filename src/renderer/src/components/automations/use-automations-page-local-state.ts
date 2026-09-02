import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Automation,
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import type { AutomationCreateTarget, AutomationDraft } from './AutomationEditorDialog'
import { AUTOMATION_DEFAULT_TIME } from './automation-draft-model'
import type { AutomationActionNotice } from './automation-row-action-dispatch'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationCreateDestination } from './automation-create-destination'
import type { AutomationListRow } from './automation-list-row-identity'
import { EMPTY_AUTOMATION_LIST_FILTER, type AutomationListFilter } from './automation-list-view'
import type {
  AutomationPaneTab,
  AutomationRunPageOrigin,
  AutomationsPageView,
  SelectedExternalRunPage
} from './automation-page-state'
import type { ExternalAutomationScope } from './external-automation-scope-client'
import type { SelectedAutomationRunHistoryOutcome } from './use-selected-automation-run-history'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'

/** React-owned values for the page; host/catalog state remains in dedicated hooks. */
export function useAutomationsPageLocalState(store: AutomationsPageStoreState) {
  const { defaultAgent, setSelectedId } = store
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
  const [runHistoryReloadToken, setRunHistoryReloadToken] = useState(0)
  const [failedAuthorityKeys, setFailedAuthorityKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [ownerAction, setOwnerAction] = useState<{
    notice: AutomationActionNotice
    host: AutomationHostCatalogEntry | null
  } | null>(null)
  const [editorNotice, setEditorNotice] = useState<AutomationActionNotice | null>(null)
  const [editorNoticeHost, setEditorNoticeHost] = useState<AutomationHostCatalogEntry | null>(null)
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
  const [editingRowKey, setEditingRowKey] = useState<string | null>(null)
  const [editingDestination, setEditingDestination] = useState<{
    projectId: string
    destination: AutomationCreateDestination
  } | null>(null)
  const [editingHostStableKey, setEditingHostStableKey] = useState<string | null>(null)
  const moveCreationKeysRef = useRef(new Map<string, string>())
  const [relativeNow, setRelativeNow] = useState(() => Date.now())
  const [pageView, setPageView] = useState<AutomationsPageView>('automations')
  const [runPageOrigin, setRunPageOrigin] = useState<AutomationRunPageOrigin>('runs')
  const [activePaneTab, setActivePaneTab] = useState<AutomationPaneTab>('overview')
  const [selectedAutomationRunPageId, setSelectedAutomationRunPageId] = useState<string | null>(
    null
  )
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null)
  const [selectedExternalKey, setSelectedExternalKey] = useState<string | null>(null)
  const [selectedExternalRunPage, setSelectedExternalRunPage] =
    useState<SelectedExternalRunPage | null>(null)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const selectedExternalKeyRef = useRef<string | null>(null)
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
    scope: ExternalAutomationScope
  } | null>(null)
  const [dontAskDeleteAgain, setDontAskDeleteAgain] = useState(false)
  const editRequestRef = useRef(0)
  const deleteConfirmButtonRef = useRef<HTMLButtonElement>(null)
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
  // Keep async editor actions on the latest draft before they can run.
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  draftRef.current = draft

  return {
    automations,
    setAutomations,
    automationHostTargetKey,
    setAutomationHostTargetKey,
    selectedAutomationRuns,
    setSelectedAutomationRuns,
    runHistoryReloadToken,
    setRunHistoryReloadToken,
    failedAuthorityKeys,
    setFailedAuthorityKeys,
    ownerAction,
    setOwnerAction,
    editorNotice,
    setEditorNotice,
    editorNoticeHost,
    setEditorNoticeHost,
    externalActionKey,
    setExternalActionKey,
    rerunRunIdsInFlight,
    setRerunRunIdsInFlight,
    isLoading,
    setIsLoading,
    isSaving,
    setIsSaving,
    listSearchQuery,
    setListSearchQuery,
    listFilter,
    setListFilter,
    createOpen,
    setCreateOpen,
    createTarget,
    setCreateTarget,
    editingAutomationId,
    setEditingAutomationId,
    editingRowKey,
    setEditingRowKey,
    editingDestination,
    setEditingDestination,
    editingHostStableKey,
    setEditingHostStableKey,
    moveCreationKeysRef,
    relativeNow,
    setRelativeNow,
    pageView,
    setPageView,
    runPageOrigin,
    setRunPageOrigin,
    activePaneTab,
    setActivePaneTab,
    selectedAutomationRunPageId,
    setSelectedAutomationRunPageId,
    selectedRowKey,
    setSelectedRowKey,
    selectedExternalKey,
    setSelectedExternalKey,
    selectedExternalRunPage,
    setSelectedExternalRunPage,
    isDetailOpen,
    setIsDetailOpen,
    selectedExternalKeyRef,
    selectAutomationId,
    selectExternalKey,
    draftAtOpen,
    setDraftAtOpen,
    deleteTarget,
    setDeleteTarget,
    externalDeleteTarget,
    setExternalDeleteTarget,
    editingExternalTarget,
    setEditingExternalTarget,
    dontAskDeleteAgain,
    setDontAskDeleteAgain,
    editRequestRef,
    deleteConfirmButtonRef,
    externalDeleteConfirmButtonRef,
    rerunRunIdsInFlightRef,
    workspaceNameCacheRef,
    setupDecisionPolicyDefaultRef,
    setupDecisionDefaultSignatureRef,
    setupDecisionTouchedRef,
    automationHookCheckPromisesRef,
    automationYamlHooksByRepoKey,
    setAutomationYamlHooksByRepoKey,
    draft,
    setDraft,
    draftRef
  }
}

export type AutomationsPageLocalState = ReturnType<typeof useAutomationsPageLocalState>
