import type {
  ItsaplanComment,
  ItsaplanConnectionStatus,
  ItsaplanCreateIssueArgs,
  ItsaplanIssue,
  ItsaplanIssueDetail,
  ItsaplanIssueListQuery,
  ItsaplanIssueUpdate,
  ItsaplanProject,
  ItsaplanProjectMetadata,
  ItsaplanResult,
  ItsaplanViewer
} from '../../../../../shared/itsaplan/itsaplan-types'

export type ItsaplanIssueListEntry = {
  issues: ItsaplanIssue[]
  fetchedAt: number
  error: string | null
  loading: boolean
}

export type ItsaplanSlice = {
  itsaplanStatus: ItsaplanConnectionStatus | null
  // getProviderRuntimeContextKey the status and caches were read under.
  itsaplanStatusContextKey: string | null
  refreshItsaplanStatus: () => Promise<ItsaplanConnectionStatus>
  connectItsaplan: (args: {
    appUrl: string
    apiUrl?: string
    apiKey: string
  }) => Promise<ItsaplanResult<{ viewer: ItsaplanViewer }>>
  detectItsaplanApiUrl: (
    appUrl: string
  ) => Promise<ItsaplanResult<{ appUrl: string; apiUrl: string }>>
  disconnectItsaplan: () => Promise<void>
  itsaplanProjects: ItsaplanProject[] | null
  loadItsaplanProjects: (opts?: { force?: boolean }) => Promise<ItsaplanProject[]>
  // key: projectRef
  itsaplanProjectMetadata: Record<string, ItsaplanProjectMetadata>
  loadItsaplanProjectMetadata: (
    projectRef: string,
    opts?: { force?: boolean }
  ) => Promise<ItsaplanProjectMetadata>
  // key: itsaplanIssueListCacheKey(query)
  itsaplanIssueLists: Record<string, ItsaplanIssueListEntry>
  loadItsaplanIssues: (
    query: ItsaplanIssueListQuery,
    opts?: { force?: boolean }
  ) => Promise<ItsaplanIssue[]>
  itsaplanIssueDetails: Record<number, ItsaplanIssueDetail>
  loadItsaplanIssueDetail: (
    issueId: number,
    opts?: { force?: boolean; projectRef?: string }
  ) => Promise<ItsaplanIssueDetail | null>
  createItsaplanIssue: (
    args: ItsaplanCreateIssueArgs
  ) => Promise<ItsaplanResult<{ issue: ItsaplanIssue }>>
  updateItsaplanIssue: (
    issueId: number,
    updates: ItsaplanIssueUpdate,
    projectRef?: string
  ) => Promise<ItsaplanResult<{ issue: ItsaplanIssue }>>
  addItsaplanComment: (
    issueId: number,
    body: string
  ) => Promise<ItsaplanResult<{ comment: ItsaplanComment }>>
}

// Stable across filter key order and array order so equal queries share one cache entry.
export function itsaplanIssueListCacheKey(query: ItsaplanIssueListQuery): string {
  const { filters } = query
  const assignee = filters.assignee
  return JSON.stringify({
    projectRef: query.projectRef,
    stateTypes: filters.stateTypes ? [...filters.stateTypes].sort() : null,
    assignee:
      assignee && typeof assignee === 'object' ? { userId: assignee.userId } : (assignee ?? null),
    labelIds: filters.labelIds ? [...filters.labelIds].sort((a, b) => a - b) : null,
    search: query.search ?? null,
    limit: query.limit ?? null
  })
}
