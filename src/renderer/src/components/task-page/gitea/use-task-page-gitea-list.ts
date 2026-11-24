import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import type { TaskPageProviderMetadataModel } from '../use-task-page-provider-metadata'
import { translate } from '@/i18n/i18n'
import { readIpcErrorDetail } from '@/runtime/errors/ipc-error'
import { knownUnreachableRuntimeHostError } from '@/runtime/hosts/connections/runtime-host-connection-state'
import { giteaApiFor } from '@/runtime/repository-gitea/gitea-owner-api'
import { GITEA_WEB_RPC_METHODS } from '@/web/preload-api/gitea/web-gitea-routes'
import type { GiteaIssueScope } from '@/store/slices/gitea/gitea'
import type { GiteaWorkspaceSelection } from '@/components/gitea-item-dialog/GiteaIssueWorkspace'
import { mapSettledWithConcurrency } from '../../../../../shared/concurrency/map-with-concurrency'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { GiteaWorkItem, GiteaWorkItemFilter } from '../../../../../shared/gitea/gitea-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { getTaskPageRepoSourceContext } from '../../../lib/work-items/task-repo-source-context'

// Leave headroom below the runtime RPC foreground concurrency of eight, as GitLab does.
const GITEA_TASK_FETCH_CONCURRENCY = 6
const GITEA_TASK_LIST_LIMIT = 50

export type GiteaTaskView = 'all' | 'issues' | 'prs'

/** A work item stamped with the repo row that answered, so twins on two hosts stay distinct. */
export type GiteaTaskRow = GiteaWorkItem & { repoId: string; repoHostId: string }

export function giteaTaskRepoScope(repo: Repo): GiteaIssueScope {
  return {
    repoPath: repo.path,
    repoId: repo.id,
    sourceContext: getTaskPageRepoSourceContext(repo, 'gitea'),
    repoOwnerExecutionHostId: getRepoExecutionHostId(repo)
  }
}

type GiteaListInput = {
  taskSource: string
  selectedRepos: readonly Repo[]
  selectedReposKey: string
  unreachableTaskSourceHostIds: ReadonlySet<TaskSourceContext['hostId']>
  unreachableTaskSourceHostKey: string
  recheckUnreachableTaskSourceHosts: (options?: { force?: true }) => void
}

export function useTaskPageGiteaList<Model extends GiteaListInput>(model: Model) {
  const {
    taskSource,
    selectedRepos,
    selectedReposKey,
    unreachableTaskSourceHostIds,
    unreachableTaskSourceHostKey,
    recheckUnreachableTaskSourceHosts
  } = model
  const [giteaView, setGiteaView] = useState<GiteaTaskView>('all')
  const [giteaFilter, setGiteaFilter] = useState<GiteaWorkItemFilter>('all')
  const [giteaItems, setGiteaItems] = useState<GiteaTaskRow[]>([])
  const [giteaListQueryKey, setGiteaListQueryKey] = useState<string | null>(null)
  const [giteaLoading, setGiteaLoading] = useState(false)
  const [giteaError, setGiteaError] = useState<string | null>(null)
  const [giteaRefreshNonce, setGiteaRefreshNonce] = useState(0)
  // The open issue or PR detail; the list chrome hides while it is shown.
  const [giteaSelection, setGiteaSelection] = useState<GiteaWorkspaceSelection | null>(null)
  const currentListQueryKey = JSON.stringify([giteaFilter, selectedReposKey])
  // A nonce bump for the same query is a user Refresh, which rechecks unreachable hosts too.
  const lastRefreshRef = useRef({ nonce: giteaRefreshNonce, query: '' })

  // Reads the latest selection and host state without re-running the load on every render.
  const loadList = useEffectEvent((userRefresh: boolean, isStale: () => boolean) => {
    if (selectedRepos.length === 0) {
      setGiteaItems([])
      setGiteaListQueryKey(currentListQueryKey)
      setGiteaLoading(false)
      setGiteaError(null)
      return
    }
    setGiteaLoading(true)
    setGiteaError(null)
    recheckUnreachableTaskSourceHosts(userRefresh ? { force: true } : undefined)
    const filter = giteaFilter === 'all' ? undefined : giteaFilter
    void loadGiteaTaskRows(selectedRepos, filter, unreachableTaskSourceHostIds, isStale)
      .then(({ rows, error }) => {
        if (isStale()) {
          return
        }
        setGiteaItems(rows)
        setGiteaListQueryKey(currentListQueryKey)
        setGiteaError(error)
      })
      .finally(() => {
        if (!isStale()) {
          setGiteaLoading(false)
        }
      })
  })

  useEffect(() => {
    const userRefresh =
      giteaRefreshNonce !== lastRefreshRef.current.nonce &&
      currentListQueryKey === lastRefreshRef.current.query
    lastRefreshRef.current = { nonce: giteaRefreshNonce, query: currentListQueryKey }
    if (taskSource !== 'gitea') {
      return
    }
    let stale = false
    loadList(userRefresh, () => stale)
    return () => {
      stale = true
    }
  }, [taskSource, giteaRefreshNonce, currentListQueryKey, unreachableTaskSourceHostKey])

  const listIsCurrent = giteaListQueryKey === currentListQueryKey
  const displayedGiteaItems = useMemo(() => {
    if (!listIsCurrent) {
      return []
    }
    if (giteaView === 'issues') {
      return giteaItems.filter((item) => item.type === 'issue')
    }
    if (giteaView === 'prs') {
      return giteaItems.filter((item) => item.type === 'pull')
    }
    return giteaItems
  }, [giteaItems, giteaView, listIsCurrent])

  return Object.assign(model, {
    giteaView,
    setGiteaView,
    giteaFilter,
    setGiteaFilter,
    giteaItems: listIsCurrent ? giteaItems : [],
    // Rows belong to the query that loaded them, so a changed filter shows loading, never old rows.
    giteaLoading: giteaLoading || (taskSource === 'gitea' && !listIsCurrent),
    giteaError: listIsCurrent ? giteaError : null,
    setGiteaRefreshNonce,
    displayedGiteaItems,
    giteaSelection: taskSource === 'gitea' ? giteaSelection : null,
    setGiteaSelection
  })
}
export type TaskPageGiteaListModel = ReturnType<
  typeof useTaskPageGiteaList<TaskPageProviderMetadataModel>
>

/** Reads every repo on its owning host; a fetch error surfaces only when no repo listed anything. */
async function loadGiteaTaskRows(
  repos: readonly Repo[],
  filter: GiteaWorkItemFilter | undefined,
  unreachableHostIds: ReadonlySet<TaskSourceContext['hostId']>,
  isStale: () => boolean
): Promise<{ rows: GiteaTaskRow[]; error: string | null }> {
  const results = await mapSettledWithConcurrency(
    repos,
    GITEA_TASK_FETCH_CONCURRENCY,
    async (repo): Promise<{ repo: Repo; items: GiteaWorkItem[] }> => {
      // A stale selection's results are discarded, so skip repos not yet started.
      if (isStale()) {
        return { repo, items: [] }
      }
      const hostId = getTaskPageRepoSourceContext(repo, 'gitea')?.hostId
      if (hostId !== undefined && unreachableHostIds.has(hostId)) {
        throw knownUnreachableRuntimeHostError(GITEA_WEB_RPC_METHODS.listWorkItems)
      }
      const scope = giteaTaskRepoScope(repo)
      const items = await giteaApiFor(scope).listWorkItems({
        ...scope,
        filter,
        limit: GITEA_TASK_LIST_LIMIT
      })
      return { repo, items }
    }
  )
  const rows: GiteaTaskRow[] = []
  const errors: string[] = []
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      errors.push(
        readIpcErrorDetail(result.reason) ??
          translate(
            'auto.components.TaskPage.giteaLoadFailed',
            'Could not load Gitea work items. Refresh to try again.'
          )
      )
      continue
    }
    const repoHostId = getRepoExecutionHostId(result.value.repo)
    for (const item of result.value.items) {
      rows.push({ ...item, repoId: result.value.repo.id, repoHostId })
    }
  }
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  // Non-Gitea repos in a mixed selection list nothing, so only an empty result surfaces errors.
  return { rows, error: errors.length > 0 && rows.length === 0 ? errors[0] : null }
}
