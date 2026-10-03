import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { createBusinessmapCollectionReadActions } from './businessmap-collection-read-actions'
import { createBusinessmapConnectionActions } from './businessmap-connection-actions'
import type { BusinessmapSlice } from './businessmap-slice-contract'

export type { BusinessmapSlice } from './businessmap-slice-contract'

export const createBusinessmapSlice: StateCreator<AppState, [], [], BusinessmapSlice> = (
  set,
  get
) => ({
  businessmapStatus: { connected: false, viewer: null },
  businessmapStatusChecked: false,
  businessmapStatusContextKey: null,
  businessmapConnectionRevisions: {},
  businessmapCardCache: {},
  businessmapBoardCache: {},
  businessmapSearchCache: {},
  ...createBusinessmapConnectionActions(set, get),
  ...createBusinessmapCollectionReadActions(set, get)
})
