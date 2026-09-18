import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { createMantisBTCollectionReadActions } from './mantisbt-collection-read-actions'
import { createMantisBTConnectionActions } from './mantisbt-connection-actions'
import { createMantisBTIssueReadActions } from './mantisbt-issue-read-actions'
import { createMantisBTProjectReadActions } from './mantisbt-project-read-actions'
import type { MantisBTSlice } from './mantisbt-slice-contract'

export type { MantisBTSlice } from './mantisbt-slice-contract'

export const createMantisBTSlice: StateCreator<AppState, [], [], MantisBTSlice> = (set, get) => ({
  mantisBTStatus: {
    connected: false,
    viewer: null,
    sites: [],
    activeSiteId: null,
    selectedSiteId: null
  },
  mantisBTStatusChecked: false,
  mantisBTStatusContextKey: null,
  mantisBTConnectionRevisions: {},
  mantisBTIssueCache: {},
  mantisBTSearchCache: {},
  mantisBTProjectCache: {},
  ...createMantisBTConnectionActions(set, get),
  ...createMantisBTIssueReadActions(set, get),
  ...createMantisBTCollectionReadActions(set, get),
  ...createMantisBTProjectReadActions(set, get)
})
