import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { itsaplanIssueListCacheKey } from '@/store/slices/itsaplan/itsaplan-slice-contract'
import { getProviderRuntimeContextKey } from '@/runtime/hosts/observations/provider-runtime-context'
import type {
  ItsaplanIssue,
  ItsaplanIssueListQuery
} from '../../../../../shared/itsaplan/itsaplan-types'
import { isSmartWorkspaceSourceQueryWithinLimit } from '../../../../../shared/new-workspace/smart-workspace-source-query'
import type { SmartNameMode } from '../../../../../shared/new-workspace/smart-workspace-source-results'
import {
  buildTaskSourceContextFromRepo,
  type TaskSourceContext
} from '../../../../../shared/work-items/task-source-context'
import { RESULT_LIMIT, type RepoOption } from '../name-field/smart-workspace-name-field-model'

const EMPTY_ISSUES: ItsaplanIssue[] = []

export function useItsaplanComposerSource({
  selectedRepo,
  mode,
  debouncedQuery,
  enabled
}: {
  selectedRepo: RepoOption | null
  mode: SmartNameMode
  debouncedQuery: string
  enabled: boolean
}): {
  itsaplanIssues: ItsaplanIssue[]
  itsaplanLoading: boolean
  itsaplanSourceContext: TaskSourceContext | null
} {
  const status = useAppStore((s) => s.itsaplanStatus)
  const statusCurrent = useAppStore(
    (s) => s.itsaplanStatusContextKey === getProviderRuntimeContextKey(s.settings)
  )
  const refreshStatus = useAppStore((s) => s.refreshItsaplanStatus)
  const projects = useAppStore((s) => s.itsaplanProjects)
  const loadProjects = useAppStore((s) => s.loadItsaplanProjects)
  const loadIssues = useAppStore((s) => s.loadItsaplanIssues)
  const connected = status?.connected === true
  const instance = status?.instance ?? null
  const active = enabled && mode === 'itsaplan'

  // Why: the tab is shown only when connected, so the status must load before the tab is picked.
  useEffect(() => {
    if (enabled && (status === null || !statusCurrent)) {
      void refreshStatus().catch(() => {})
    }
  }, [enabled, refreshStatus, status, statusCurrent])
  useEffect(() => {
    if (active && connected && projects === null) {
      void loadProjects().catch(() => {})
    }
  }, [active, connected, loadProjects, projects])

  const repoDefault = selectedRepo?.defaultItsaplanProject
  const projectRef =
    repoDefault && repoDefault.instanceId === instance?.id
      ? repoDefault.projectRef
      : (projects?.[0]?.ref ?? null)
  const search = debouncedQuery.trim()
  const query = useMemo<ItsaplanIssueListQuery | null>(
    () =>
      active && connected && projectRef && isSmartWorkspaceSourceQueryWithinLimit(search)
        ? {
            projectRef,
            filters: { stateTypes: ['backlog', 'unstarted', 'started'] },
            ...(search ? { search } : {}),
            limit: RESULT_LIMIT
          }
        : null,
    [active, connected, projectRef, search]
  )
  const queryKey = query ? itsaplanIssueListCacheKey(query) : null
  const entry = useAppStore((s) => (queryKey ? s.itsaplanIssueLists[queryKey] : undefined))
  useEffect(() => {
    if (query) {
      void loadIssues(query).catch(() => {})
    }
  }, [loadIssues, query])

  const itsaplanSourceContext = useMemo(
    () =>
      selectedRepo && instance
        ? buildTaskSourceContextFromRepo({
            provider: 'itsaplan',
            projectId: selectedRepo.id,
            repo: selectedRepo,
            providerIdentity: { provider: 'itsaplan', instanceId: instance.id, projectRef },
            accountLabel: instance.appUrl
          })
        : null,
    [instance, projectRef, selectedRepo]
  )

  return {
    itsaplanIssues: query ? (entry?.issues ?? EMPTY_ISSUES) : EMPTY_ISSUES,
    itsaplanLoading: query !== null && (entry?.loading ?? true),
    itsaplanSourceContext
  }
}
