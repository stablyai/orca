import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import { DISCONNECTED_CLICKUP_STATUS } from '@/runtime/clickup/runtime-clickup-connection-status'
import { createClickUpConnectionActions } from './clickup-connection-actions'
import { createClickUpReadActions } from './clickup-read-actions'
import type { ClickUpSlice } from './clickup-slice-contract'
import { createClickUpWriteActions } from './clickup-write-actions'

export const createClickUpSlice: StateCreator<AppState, [], [], ClickUpSlice> = (set, get) => ({
  clickupStatus: DISCONNECTED_CLICKUP_STATUS,
  clickupStatusChecked: false,
  clickupStatusContextKey: null,
  clickupConnectionLost: false,
  clickupRuntimeUpdateRequired: false,
  clickupTaskCache: {},
  clickupListCache: {},
  clickupCommentCache: {},
  clickupStatusOptionsCache: {},
  ...createClickUpConnectionActions(set, get),
  ...createClickUpReadActions(set, get),
  ...createClickUpWriteActions(set, get)
})
