import type { StateCreator } from 'zustand'
import type { CacheEntry } from '../github/cache-model'
import type { AppState } from '../types'
import type {
  JiraAuthType,
  JiraConnectionStatus,
  JiraIssue,
  JiraIssueFilter,
  JiraSiteSelection,
  JiraViewer
} from '../../../../shared/jira-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

export type JiraReadOptions = {
  sourceContext?: TaskSourceContext | null
  siteId?: JiraSiteSelection | null
}

export type JiraSearchOptions = JiraReadOptions & { signal?: AbortSignal }
export type JiraPatchOptions = { sourceContext?: TaskSourceContext | null }
export type JiraIssueSummaryLookupOptions = { force?: boolean; signal?: AbortSignal }

export type JiraSlice = {
  jiraStatus: JiraConnectionStatus
  jiraStatusChecked: boolean
  jiraStatusContextKey: string | null
  jiraConnectionRevisions: Record<string, number>
  jiraIssueCache: Record<string, CacheEntry<JiraIssue>>
  jiraIssueSummaryCache: Record<string, CacheEntry<JiraIssue | null>>
  jiraSearchCache: Record<string, CacheEntry<JiraIssue[]>>

  checkJiraConnection: () => Promise<void>
  readJiraStatus: (sourceContext: TaskSourceContext) => Promise<JiraConnectionStatus>
  lookupJiraIssueSummary: (
    sourceContext: TaskSourceContext,
    key: string,
    siteId: string,
    options?: JiraIssueSummaryLookupOptions
  ) => Promise<JiraIssue | null>
  connectJira: (args: {
    siteUrl: string
    email: string
    apiToken: string
    authType?: JiraAuthType
  }) => Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }>
  testJiraConnection: (
    siteId?: string | null
  ) => Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }>
  selectJiraSite: (siteId: JiraSiteSelection) => Promise<void>
  disconnectJira: (siteId?: string | null) => Promise<void>
  fetchJiraIssue: (
    key: string,
    siteId?: string | null,
    options?: JiraReadOptions
  ) => Promise<JiraIssue | null>
  searchJiraIssues: (
    jql: string,
    limit?: number,
    options?: JiraSearchOptions
  ) => Promise<JiraIssue[]>
  listJiraIssues: (
    filter?: JiraIssueFilter,
    limit?: number,
    options?: JiraReadOptions
  ) => Promise<JiraIssue[]>
  patchJiraIssue: (issueKey: string, patch: Partial<JiraIssue>, options?: JiraPatchOptions) => void
}

type JiraStateCreator = StateCreator<AppState, [], [], JiraSlice>

export type JiraSliceSet = Parameters<JiraStateCreator>[0]
export type JiraSliceGet = Parameters<JiraStateCreator>[1]
