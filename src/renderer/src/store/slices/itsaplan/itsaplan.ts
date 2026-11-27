import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { ItsaplanSlice } from './itsaplan-slice-contract'

const notImplemented = (): Promise<never> =>
  Promise.reject(new Error('itsaplan slice not implemented'))

export const createItsaplanSlice: StateCreator<AppState, [], [], ItsaplanSlice> = () => ({
  itsaplanStatus: null,
  refreshItsaplanStatus: notImplemented,
  connectItsaplan: notImplemented,
  detectItsaplanApiUrl: notImplemented,
  disconnectItsaplan: notImplemented,
  itsaplanProjects: null,
  loadItsaplanProjects: notImplemented,
  itsaplanProjectMetadata: {},
  loadItsaplanProjectMetadata: notImplemented,
  itsaplanIssueLists: {},
  loadItsaplanIssues: notImplemented,
  itsaplanIssueDetails: {},
  loadItsaplanIssueDetail: notImplemented,
  createItsaplanIssue: notImplemented,
  updateItsaplanIssue: notImplemented,
  addItsaplanComment: notImplemented
})
