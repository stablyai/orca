import type { TaskPageJiraListStateModel } from '../jira/use-task-page-jira-list-state'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { itsaplanIssueListCacheKey } from '@/store/slices/itsaplan/itsaplan-slice-contract'
import type {
  ItsaplanIssue,
  ItsaplanIssueListFilters,
  ItsaplanIssueListQuery,
  ItsaplanStateType
} from '../../../../../shared/itsaplan/itsaplan-types'
import { normalizeTaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { useTaskSearchDebouncedApply } from '../use-task-search-debounced-apply'
import {
  getItsaplanErrorMessage,
  isItsaplanInvalidApiKeyError
} from './task-page-itsaplan-load-error'

export const ITSAPLAN_DEFAULT_STATE_TYPES: readonly ItsaplanStateType[] = ['unstarted', 'started']
const EMPTY_ISSUES: ItsaplanIssue[] = []

export type ItsaplanAssigneeFilter = ItsaplanIssueListFilters['assignee']

export function getItsaplanInstanceName(appUrl: string | null | undefined): string | null {
  if (!appUrl) {
    return null
  }
  try {
    return new URL(appUrl).host
  } catch {
    return appUrl
  }
}

export function useTaskPageItsaplanListState(model: TaskPageJiraListStateModel) {
  const {
    taskSource,
    primaryRepo,
    accountBackedTaskSourceHostId,
    fallbackTaskSourceProjectId,
    providerRuntimeContextKey
  } = model
  const itsaplanStatus = useAppStore((s) => s.itsaplanStatus)
  const itsaplanStatusCurrent = useAppStore(
    (s) => s.itsaplanStatusContextKey === providerRuntimeContextKey
  )
  const refreshItsaplanStatus = useAppStore((s) => s.refreshItsaplanStatus)
  const itsaplanProjects = useAppStore((s) => s.itsaplanProjects)
  const loadItsaplanProjects = useAppStore((s) => s.loadItsaplanProjects)
  const loadItsaplanProjectMetadata = useAppStore((s) => s.loadItsaplanProjectMetadata)
  const loadItsaplanIssues = useAppStore((s) => s.loadItsaplanIssues)
  const itsaplanActive = taskSource === 'itsaplan'
  const [itsaplanStatusFailed, setItsaplanStatusFailed] = useState(false)
  const itsaplanStatusReady = itsaplanStatus !== null || itsaplanStatusFailed
  const itsaplanConnected = itsaplanStatus?.connected === true
  const itsaplanInstance = itsaplanStatus?.instance ?? null
  const itsaplanInstanceId = itsaplanInstance?.id ?? null
  const itsaplanInstanceName = getItsaplanInstanceName(itsaplanInstance?.appUrl)
  const [itsaplanConnectOpen, setItsaplanConnectOpen] = useState(false)
  const [newItsaplanIssueOpen, setNewItsaplanIssueOpen] = useState(false)

  useEffect(() => {
    if (!itsaplanActive || (itsaplanStatus !== null && itsaplanStatusCurrent)) {
      return
    }
    void refreshItsaplanStatus().catch(() => setItsaplanStatusFailed(true))
  }, [itsaplanActive, itsaplanStatus, itsaplanStatusCurrent, refreshItsaplanStatus])

  const [itsaplanProjectsError, setItsaplanProjectsError] = useState<string | null>(null)
  useEffect(() => {
    if (!itsaplanActive || !itsaplanConnected || itsaplanProjects !== null) {
      return
    }
    let cancelled = false
    setItsaplanProjectsError(null)
    void loadItsaplanProjects().catch((error: unknown) => {
      if (!cancelled) {
        setItsaplanProjectsError(getItsaplanErrorMessage(error))
      }
    })
    return () => {
      cancelled = true
    }
  }, [itsaplanActive, itsaplanConnected, itsaplanProjects, loadItsaplanProjects])

  const [chosenItsaplanProjectRef, setChosenItsaplanProjectRef] = useState<string | null>(null)
  const repoDefaultProject = primaryRepo?.defaultItsaplanProject
  const repoDefaultProjectRef =
    repoDefaultProject && repoDefaultProject.instanceId === itsaplanInstanceId
      ? repoDefaultProject.projectRef
      : null
  const itsaplanProjectRef = useMemo(() => {
    const candidates = [chosenItsaplanProjectRef, repoDefaultProjectRef].filter(
      (ref): ref is string => Boolean(ref)
    )
    if (!itsaplanProjects) {
      return candidates[0] ?? null
    }
    return (
      candidates.find((ref) => itsaplanProjects.some((project) => project.ref === ref)) ??
      itsaplanProjects[0]?.ref ??
      null
    )
  }, [chosenItsaplanProjectRef, itsaplanProjects, repoDefaultProjectRef])
  const selectedItsaplanProject =
    itsaplanProjects?.find((project) => project.ref === itsaplanProjectRef) ?? null
  const itsaplanMetadata = useAppStore((s) =>
    itsaplanProjectRef ? s.itsaplanProjectMetadata[itsaplanProjectRef] : undefined
  )
  useEffect(() => {
    if (!itsaplanActive || !itsaplanConnected || !itsaplanProjectRef || itsaplanMetadata) {
      return
    }
    void loadItsaplanProjectMetadata(itsaplanProjectRef).catch(() => {
      console.warn("[TaskPage] Failed to load It's a Plan project metadata")
    })
  }, [
    itsaplanActive,
    itsaplanConnected,
    itsaplanMetadata,
    itsaplanProjectRef,
    loadItsaplanProjectMetadata
  ])

  const [itsaplanStateTypes, setItsaplanStateTypes] = useState<readonly ItsaplanStateType[]>(
    ITSAPLAN_DEFAULT_STATE_TYPES
  )
  const [itsaplanAssignee, setItsaplanAssignee] = useState<ItsaplanAssigneeFilter>('me')
  const [itsaplanLabelIds, setItsaplanLabelIds] = useState<readonly number[]>([])
  const [itsaplanSearchInput, setItsaplanSearchInput] = useState('')
  const [appliedItsaplanSearch, setAppliedItsaplanSearch] = useState('')
  const applyItsaplanSearch = useCallback((value: string) => {
    setAppliedItsaplanSearch(value.trim())
  }, [])
  useTaskSearchDebouncedApply(itsaplanSearchInput, itsaplanActive, applyItsaplanSearch)

  // Label and member ids are per project, so a project switch drops those filters.
  const selectItsaplanProject = useCallback((projectRef: string) => {
    setChosenItsaplanProjectRef(projectRef)
    setItsaplanLabelIds([])
    setItsaplanAssignee((current) => (typeof current === 'object' ? 'me' : current))
  }, [])

  const itsaplanQuery = useMemo<ItsaplanIssueListQuery | null>(() => {
    if (!itsaplanProjectRef) {
      return null
    }
    return {
      projectRef: itsaplanProjectRef,
      filters: {
        ...(itsaplanStateTypes.length > 0 ? { stateTypes: [...itsaplanStateTypes] } : {}),
        ...(itsaplanAssignee ? { assignee: itsaplanAssignee } : {}),
        ...(itsaplanLabelIds.length > 0 ? { labelIds: [...itsaplanLabelIds] } : {})
      },
      ...(appliedItsaplanSearch ? { search: appliedItsaplanSearch } : {})
    }
  }, [
    appliedItsaplanSearch,
    itsaplanAssignee,
    itsaplanLabelIds,
    itsaplanProjectRef,
    itsaplanStateTypes
  ])
  const itsaplanQueryKey = itsaplanQuery ? itsaplanIssueListCacheKey(itsaplanQuery) : null
  const itsaplanListEntry = useAppStore((s) =>
    itsaplanQueryKey ? s.itsaplanIssueLists[itsaplanQueryKey] : undefined
  )
  const [itsaplanRequestError, setItsaplanRequestError] = useState<{
    key: string
    message: string
  } | null>(null)
  const runItsaplanListLoad = useCallback(
    (query: ItsaplanIssueListQuery, force: boolean, isCurrent: () => boolean) => {
      const key = itsaplanIssueListCacheKey(query)
      setItsaplanRequestError(null)
      void loadItsaplanIssues(query, force ? { force: true } : undefined).catch(
        (error: unknown) => {
          if (isCurrent()) {
            setItsaplanRequestError({ key, message: getItsaplanErrorMessage(error) })
          }
        }
      )
    },
    [loadItsaplanIssues]
  )
  useEffect(() => {
    if (!itsaplanActive || !itsaplanConnected || !itsaplanQuery) {
      return
    }
    let cancelled = false
    runItsaplanListLoad(itsaplanQuery, false, () => !cancelled)
    return () => {
      cancelled = true
    }
  }, [itsaplanActive, itsaplanConnected, itsaplanQuery, runItsaplanListLoad])
  const refreshItsaplan = useCallback(() => {
    void refreshItsaplanStatus().catch(() => setItsaplanStatusFailed(true))
    setItsaplanProjectsError(null)
    void loadItsaplanProjects({ force: true }).catch((error: unknown) => {
      setItsaplanProjectsError(getItsaplanErrorMessage(error))
    })
    if (itsaplanQuery) {
      runItsaplanListLoad(itsaplanQuery, true, () => true)
    }
  }, [itsaplanQuery, loadItsaplanProjects, refreshItsaplanStatus, runItsaplanListLoad])

  const itsaplanIssues = itsaplanListEntry?.issues ?? EMPTY_ISSUES
  const itsaplanRequestErrorMessage =
    itsaplanRequestError && itsaplanRequestError.key === itsaplanQueryKey
      ? itsaplanRequestError.message
      : null
  const itsaplanError =
    itsaplanListEntry?.error ?? itsaplanRequestErrorMessage ?? itsaplanProjectsError
  const itsaplanLoading =
    itsaplanListEntry?.loading ??
    (itsaplanQuery !== null ? !itsaplanError : itsaplanProjects === null && !itsaplanError)
  const itsaplanCredentialInvalid =
    Boolean(itsaplanStatus?.credentialError) || isItsaplanInvalidApiKeyError(itsaplanError)

  const itsaplanTaskSourceContext = useMemo(
    () =>
      normalizeTaskSourceContext({
        provider: 'itsaplan',
        projectId: fallbackTaskSourceProjectId,
        hostId: accountBackedTaskSourceHostId,
        providerIdentity: {
          provider: 'itsaplan',
          instanceId: itsaplanInstanceId,
          projectRef: itsaplanProjectRef
        },
        accountLabel: itsaplanInstanceName
      }),
    [
      accountBackedTaskSourceHostId,
      fallbackTaskSourceProjectId,
      itsaplanInstanceId,
      itsaplanInstanceName,
      itsaplanProjectRef
    ]
  )

  return Object.assign(model, {
    itsaplanStatus,
    itsaplanStatusReady,
    itsaplanConnected,
    itsaplanInstance,
    itsaplanInstanceName,
    itsaplanConnectOpen,
    setItsaplanConnectOpen,
    newItsaplanIssueOpen,
    setNewItsaplanIssueOpen,
    itsaplanProjects,
    itsaplanProjectRef,
    selectedItsaplanProject,
    selectItsaplanProject,
    itsaplanMetadata,
    itsaplanStateTypes,
    setItsaplanStateTypes,
    itsaplanAssignee,
    setItsaplanAssignee,
    itsaplanLabelIds,
    setItsaplanLabelIds,
    itsaplanSearchInput,
    setItsaplanSearchInput,
    appliedItsaplanSearch,
    setAppliedItsaplanSearch,
    itsaplanIssues,
    itsaplanLoading,
    itsaplanError,
    itsaplanCredentialInvalid,
    refreshItsaplan,
    itsaplanTaskSourceContext
  })
}
export type TaskPageItsaplanListStateModel = ReturnType<typeof useTaskPageItsaplanListState>
