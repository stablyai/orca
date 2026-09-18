import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { CacheEntry } from '../github/cache-model'
import type {
  MantisBTConnectArgs,
  MantisBTConnectionStatus,
  MantisBTIssue,
  MantisBTIssueFilter,
  MantisBTProject,
  MantisBTSiteSelection,
  MantisBTViewer
} from '../../../../shared/mantisbt-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

export type MantisBTReadOptions = {
  sourceContext?: TaskSourceContext | null
  siteId?: MantisBTSiteSelection | null
  projectId?: string | null
  // Why: only consulted by listMantisBTIssues, and only against a local
  // (non-remote) runtime target — see runtime-mantisbt-client.ts.
  onProgress?: (issues: MantisBTIssue[]) => void
}
export type MantisBTSlice = {
  mantisBTStatus: MantisBTConnectionStatus
  mantisBTStatusChecked: boolean
  mantisBTStatusContextKey: string | null
  mantisBTConnectionRevisions: Record<string, number>

  checkMantisBTConnection: () => Promise<void>
  connectMantisBT: (
    args: MantisBTConnectArgs
  ) => Promise<{ ok: true; viewer: MantisBTViewer } | { ok: false; error: string }>
  testMantisBTConnection: (
    siteId?: string | null
  ) => Promise<{ ok: true; viewer: MantisBTViewer } | { ok: false; error: string }>
  selectMantisBTSite: (siteId: MantisBTSiteSelection) => Promise<void>
  disconnectMantisBT: (siteId?: string | null) => Promise<void>

  mantisBTIssueCache: Record<string, CacheEntry<MantisBTIssue>>
  mantisBTSearchCache: Record<string, CacheEntry<MantisBTIssue[]>>
  mantisBTProjectCache: Record<string, CacheEntry<MantisBTProject[]>>

  fetchMantisBTIssue: (
    id: string,
    siteId?: string | null,
    options?: MantisBTReadOptions
  ) => Promise<MantisBTIssue | null>
  listMantisBTIssues: (
    filter?: MantisBTIssueFilter,
    limit?: number,
    options?: MantisBTReadOptions
  ) => Promise<MantisBTIssue[]>
  listMantisBTProjects: (options?: MantisBTReadOptions) => Promise<MantisBTProject[]>
}

type MantisBTStateCreator = StateCreator<AppState, [], [], MantisBTSlice>

export type MantisBTSliceSet = Parameters<MantisBTStateCreator>[0]
export type MantisBTSliceGet = Parameters<MantisBTStateCreator>[1]
