import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { redmineListInvalidationToken } from './redmine/redmine-cache'
import { createRedmineActions } from './redmine/redmine-slice-actions'
import type { RedmineSlice } from './redmine/redmine-slice-contract'

export type { RedmineSlice } from './redmine/redmine-slice-contract'

export const createRedmineSlice: StateCreator<AppState, [], [], RedmineSlice> = (set, get) => ({
  redmineStatus: {
    connected: false,
    activeSite: null,
    selectedSiteId: null,
    viewer: null,
    error: null
  },
  redmineStatusChecked: false,
  redmineStatusContextKey: null,
  redmineIssueCache: {},
  redmineListCache: {},
  redmineListInvalidationToken,
  ...createRedmineActions(set, get)
})
