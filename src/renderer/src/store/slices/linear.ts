import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { linearListInvalidationToken } from './linear/linear-cache'
import { createLinearConnectionActions } from './linear/linear-slice-connection-actions'
import { createLinearCustomViewDetailActions } from './linear/linear-custom-view-detail-actions'
import { createLinearCustomViewIssueActions } from './linear/linear-custom-view-issue-actions'
import { createLinearCustomViewListActions } from './linear/linear-custom-view-list-actions'
import { createLinearCustomViewProjectActions } from './linear/linear-custom-view-project-actions'
import { createLinearInvalidationActions } from './linear/linear-invalidation-actions'
import { createLinearIssueCacheActions } from './linear/linear-issue-cache-actions'
import { createLinearIssueDetailActions } from './linear/linear-issue-detail-actions'
import { createLinearIssueListActions } from './linear/linear-issue-list-actions'
import { createLinearProjectDetailActions } from './linear/linear-project-detail-actions'
import { createLinearProjectIssueActions } from './linear/linear-project-issue-actions'
import { createLinearProjectListActions } from './linear/linear-project-list-actions'
import { createLinearStatusActions } from './linear/linear-slice-status-actions'
import { createLinearTeamActions } from './linear/linear-team-actions'
import type { LinearSlice } from './linear/linear-slice-contract'

export type {
  LinearFetchOptions,
  LinearIssueListReadArgs,
  LinearIssueReadArgs,
  LinearPatchOptions,
  LinearSlice
} from './linear/linear-slice-contract'

export const createLinearSlice: StateCreator<AppState, [], [], LinearSlice> = (set, get) => ({
  linearStatus: { connected: false, viewer: null },
  linearStatusChecked: false,
  linearStatusContextKey: null,
  linearIssueCache: {},
  linearSearchCache: {},
  linearListCache: {},
  linearTeamCache: {},
  linearProjectCache: {},
  linearProjectDetailCache: {},
  linearProjectIssueCache: {},
  linearCustomViewCache: {},
  linearCustomViewDetailCache: {},
  linearCustomViewIssueCache: {},
  linearCustomViewProjectCache: {},
  linearListInvalidationToken,
  ...createLinearStatusActions(set, get),
  ...createLinearConnectionActions(set, get),
  ...createLinearIssueDetailActions(set, get),
  ...createLinearIssueCacheActions(set, get),
  ...createLinearIssueListActions(set, get),
  ...createLinearTeamActions(set, get),
  ...createLinearProjectListActions(set, get),
  ...createLinearProjectDetailActions(set, get),
  ...createLinearProjectIssueActions(set, get),
  ...createLinearCustomViewListActions(set, get),
  ...createLinearCustomViewDetailActions(set, get),
  ...createLinearCustomViewIssueActions(set, get),
  ...createLinearCustomViewProjectActions(set, get),
  ...createLinearInvalidationActions(set, get)
})
