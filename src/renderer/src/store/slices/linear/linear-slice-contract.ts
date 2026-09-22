import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearCustomViewModel,
  LinearCustomViewSummary,
  LinearProjectDetail,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearConnectionStatus,
  LinearTeam,
  LinearViewer,
  LinearWorkspaceSelection
} from '../../../../../shared/linear/workspace-types'
import type { CacheEntry } from '../../github/cache-model'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { LinearIssueAttributeFilter } from '../../../../../shared/linear/issue-attribute-filter'

export type LinearIssueListReadArgs = {
  kind: 'list'
  filter?: 'assigned' | 'created' | 'all' | 'completed'
  limit?: number
  attributeFilter?: LinearIssueAttributeFilter | null
}

export type LinearIssueReadArgs =
  | { kind: 'search'; query: string; limit?: number }
  | LinearIssueListReadArgs

export type LinearFetchOptions = { force?: boolean; sourceContext?: TaskSourceContext | null }
export type LinearPatchOptions = { sourceContext?: TaskSourceContext | null }

export type LinearSlice = {
  linearStatus: LinearConnectionStatus
  linearStatusChecked: boolean
  linearStatusContextKey: string | null
  linearIssueCache: Record<string, CacheEntry<LinearIssue>>
  linearSearchCache: Record<string, CacheEntry<LinearIssue[]>>
  linearListCache: Record<string, CacheEntry<LinearCollectionResult<LinearIssue>>>
  linearTeamCache: Record<string, CacheEntry<LinearTeam[]>>
  linearProjectCache: Record<string, CacheEntry<LinearCollectionResult<LinearProjectSummary>>>
  linearProjectDetailCache: Record<string, CacheEntry<LinearProjectDetail | null>>
  linearProjectIssueCache: Record<string, CacheEntry<LinearCollectionResult<LinearIssue>>>
  linearCustomViewCache: Record<string, CacheEntry<LinearCollectionResult<LinearCustomViewSummary>>>
  linearCustomViewDetailCache: Record<string, CacheEntry<LinearCustomViewSummary | null>>
  linearCustomViewIssueCache: Record<string, CacheEntry<LinearCollectionResult<LinearIssue>>>
  linearCustomViewProjectCache: Record<
    string,
    CacheEntry<LinearCollectionResult<LinearProjectSummary>>
  >

  checkLinearConnection: (force?: boolean) => Promise<void>
  connectLinear: (
    apiKey: string
  ) => Promise<{ ok: true; viewer: LinearViewer } | { ok: false; error: string }>
  testLinearConnection: (
    workspaceId?: string | null
  ) => Promise<{ ok: true; viewer: LinearViewer } | { ok: false; error: string }>
  selectLinearWorkspace: (workspaceId: LinearWorkspaceSelection) => Promise<void>
  disconnectLinear: () => Promise<void>
  disconnectLinearWorkspace: (workspaceId: string) => Promise<void>
  fetchLinearIssue: (
    id: string,
    workspaceId?: string | null,
    options?: LinearFetchOptions
  ) => Promise<LinearIssue | null>
  refreshLinearIssue: (
    id: string,
    workspaceId?: string | null,
    options?: LinearFetchOptions
  ) => Promise<LinearIssue | null>
  getCachedLinearIssues: (
    args: LinearIssueReadArgs,
    options?: Pick<LinearFetchOptions, 'sourceContext'>
  ) => LinearIssue[] | LinearCollectionResult<LinearIssue> | null
  prefetchLinearIssues: (args: LinearIssueReadArgs, options?: LinearFetchOptions) => void
  searchLinearIssues: (
    query: string,
    limit?: number,
    options?: LinearFetchOptions
  ) => Promise<LinearIssue[]>
  listLinearIssues: (
    args: LinearIssueListReadArgs,
    options?: LinearFetchOptions
  ) => Promise<LinearCollectionResult<LinearIssue>>
  linearListInvalidationToken: { scope: string; version: number }
  invalidateLinearIssueLists: (options?: Pick<LinearFetchOptions, 'sourceContext'>) => void
  getCachedLinearTeams: (
    workspaceId?: LinearWorkspaceSelection | null,
    options?: Pick<LinearFetchOptions, 'sourceContext'>
  ) => LinearTeam[] | null
  listLinearTeams: (
    workspaceId?: LinearWorkspaceSelection | null,
    options?: LinearFetchOptions
  ) => Promise<LinearTeam[]>
  getCachedLinearProjects: (
    query?: string,
    limit?: number,
    workspaceId?: LinearWorkspaceSelection | null,
    options?: Pick<LinearFetchOptions, 'sourceContext'>
  ) => LinearCollectionResult<LinearProjectSummary> | null
  listLinearProjects: (
    query?: string,
    limit?: number,
    workspaceId?: LinearWorkspaceSelection | null,
    options?: LinearFetchOptions
  ) => Promise<LinearCollectionResult<LinearProjectSummary>>
  fetchLinearProject: (
    id: string,
    workspaceId: string,
    options?: LinearFetchOptions
  ) => Promise<LinearProjectDetail | null>
  listLinearProjectIssues: (
    projectId: string,
    workspaceId: string,
    limit?: number,
    options?: LinearFetchOptions
  ) => Promise<LinearCollectionResult<LinearIssue>>
  getCachedLinearCustomViews: (
    model: LinearCustomViewModel,
    limit?: number,
    workspaceId?: LinearWorkspaceSelection | null,
    options?: Pick<LinearFetchOptions, 'sourceContext'>
  ) => LinearCollectionResult<LinearCustomViewSummary> | null
  listLinearCustomViews: (
    model: LinearCustomViewModel,
    limit?: number,
    workspaceId?: LinearWorkspaceSelection | null,
    options?: LinearFetchOptions
  ) => Promise<LinearCollectionResult<LinearCustomViewSummary>>
  fetchLinearCustomView: (
    viewId: string,
    workspaceId: string,
    model: LinearCustomViewModel,
    options?: LinearFetchOptions
  ) => Promise<LinearCustomViewSummary | null>
  listLinearCustomViewIssues: (
    viewId: string,
    workspaceId: string,
    limit?: number,
    options?: LinearFetchOptions
  ) => Promise<LinearCollectionResult<LinearIssue>>
  listLinearCustomViewProjects: (
    viewId: string,
    workspaceId: string,
    limit?: number,
    options?: LinearFetchOptions
  ) => Promise<LinearCollectionResult<LinearProjectSummary>>
  patchLinearIssue: (
    issueId: string,
    patch: Partial<LinearIssue>,
    options?: LinearPatchOptions
  ) => void
}

export type LinearSliceStateCreator = StateCreator<AppState, [], [], LinearSlice>
export type LinearSliceSet = Parameters<LinearSliceStateCreator>[0]
export type LinearSliceGet = Parameters<LinearSliceStateCreator>[1]
