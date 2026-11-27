import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import { createBitbucketConnectionActions } from './bitbucket-connection-actions'
import type { BitbucketSlice } from './bitbucket-slice-contract'

export const createBitbucketSlice: StateCreator<AppState, [], [], BitbucketSlice> = (
  _set,
  get
) => ({
  ...createBitbucketConnectionActions(get)
})
