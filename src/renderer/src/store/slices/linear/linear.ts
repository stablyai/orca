import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import { createLinearConnectionActions } from './linear-slice-connection-actions'
import { createLinearCustomViewDetailActions } from './linear-custom-view-detail-actions'
import { createLinearCustomViewIssueActions } from './linear-custom-view-issue-actions'
import { createLinearCustomViewListActions } from './linear-custom-view-list-actions'
import { createLinearCustomViewProjectActions } from './linear-custom-view-project-actions'
import { createLinearInvalidationActions } from './linear-invalidation-actions'
import { createLinearIssueCacheActions } from './linear-issue-cache-actions'
import { createLinearIssueDetailActions } from './linear-issue-detail-actions'
import { createLinearIssueListActions } from './linear-issue-list-actions'
import { createLinearProjectDetailActions } from './linear-project-detail-actions'
import { createLinearProjectIssueActions } from './linear-project-issue-actions'
import { createLinearProjectListActions } from './linear-project-list-actions'
import { createLinearStatusActions } from './linear-slice-status-actions'
import { createLinearTeamActions } from './linear-team-actions'
import type { LinearSlice } from './linear-slice-contract'

export const createLinearSlice: StateCreator<AppState, [], [], LinearSlice> = (set, get) => ({
  linearStatus: { connected: false, viewer: null },
  linearStatusObserved: false,
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
