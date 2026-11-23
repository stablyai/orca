import { clickupApiForTarget } from '@/runtime/clickup/runtime-clickup-client'
import { DISCONNECTED_CLICKUP_STATUS } from '@/runtime/clickup/runtime-clickup-connection-status'
import { translate } from '@/i18n/i18n'
import type { ClickUpConnectResult } from '../../../../../shared/clickup/clickup-types'
import type { ClickUpSlice, ClickUpSliceGet, ClickUpSliceSet } from './clickup-slice-contract'
import {
  beginClickUpConnectionChange,
  clickupOwnerContextKey,
  clickupStatusUpdate,
  currentClickUpConnectionGeneration,
  EMPTY_CLICKUP_READ_CACHES,
  hasClickUpStatusChanged,
  isCurrentClickUpConnectionChange,
  isCurrentClickUpStatusRead,
  nextClickUpStatusReadGeneration
} from './clickup-read-coordination'

type ClickUpConnectionActions = Pick<
  ClickUpSlice,
  | 'checkClickUpConnection'
  | 'connectClickUp'
  | 'testClickUpConnection'
  | 'selectClickUpWorkspace'
  | 'disconnectClickUp'
>

function failure(error: unknown, fallback: string): ClickUpConnectResult {
  return { ok: false, error: error instanceof Error ? error.message : fallback }
}

export function createClickUpConnectionActions(
  set: ClickUpSliceSet,
  get: ClickUpSliceGet
): ClickUpConnectionActions {
  return {
    checkClickUpConnection: async (owner) => {
      const contextKey = clickupOwnerContextKey(owner)
      const readGeneration = nextClickUpStatusReadGeneration()
      const connectionGeneration = currentClickUpConnectionGeneration()
      if (get().clickupStatusContextKey !== contextKey) {
        set({ clickupStatusChecked: false })
      }
      const isStale = (): boolean =>
        !isCurrentClickUpStatusRead(readGeneration) ||
        !isCurrentClickUpConnectionChange(connectionGeneration)
      let status
      let statusReadFailed = false
      try {
        status = await clickupApiForTarget(owner).status()
      } catch {
        status = DISCONNECTED_CLICKUP_STATUS
        statusReadFailed = true
      }
      if (isStale()) {
        return
      }
      const previous = get().clickupStatus
      const sameContext = get().clickupStatusContextKey === contextKey
      // An unreachable host says nothing about the token, so only a successful read that shows disconnected counts as lost.
      const lostConnection =
        !statusReadFailed && sameContext && previous.connected && !status.connected
      if (!sameContext || lostConnection || hasClickUpStatusChanged(previous, status)) {
        set(
          clickupStatusUpdate(contextKey, status, {
            clickupConnectionLost: lostConnection || (sameContext && get().clickupConnectionLost),
            ...(lostConnection ? EMPTY_CLICKUP_READ_CACHES : {})
          })
        )
      } else if (!get().clickupStatusChecked) {
        set({ clickupStatusChecked: true, clickupStatusContextKey: contextKey })
      }
    },

    connectClickUp: async (owner, token) => {
      const generation = beginClickUpConnectionChange()
      const contextKey = clickupOwnerContextKey(owner)
      const api = clickupApiForTarget(owner)
      try {
        const result = await api.connect({ token })
        if (!result.ok) {
          return result
        }
        if (!isCurrentClickUpConnectionChange(generation)) {
          return {
            ok: false,
            error: translate(
              'taskProviders.clickup.connectionSuperseded',
              'ClickUp connection was superseded by a newer request.'
            )
          }
        }
        // The connect reply carries only the viewer; the status read supplies the Workspace list.
        const status = await api.status()
        if (isCurrentClickUpConnectionChange(generation)) {
          set(
            clickupStatusUpdate(contextKey, status, {
              clickupConnectionLost: false,
              ...EMPTY_CLICKUP_READ_CACHES
            })
          )
        }
        return result
      } catch (error) {
        return failure(error, 'Connection failed')
      }
    },

    testClickUpConnection: async (owner) => {
      const generation = beginClickUpConnectionChange()
      const contextKey = clickupOwnerContextKey(owner)
      const api = clickupApiForTarget(owner)
      try {
        const result = await api.testConnection()
        const status = await api.status()
        if (isCurrentClickUpConnectionChange(generation)) {
          set(
            clickupStatusUpdate(contextKey, status, {
              clickupConnectionLost: !result.ok && !status.connected,
              ...EMPTY_CLICKUP_READ_CACHES
            })
          )
        }
        return result
      } catch (error) {
        return failure(error, 'Test failed')
      }
    },

    selectClickUpWorkspace: async (owner, workspaceId) => {
      const generation = beginClickUpConnectionChange()
      const contextKey = clickupOwnerContextKey(owner)
      const api = clickupApiForTarget(owner)
      const status = await api.selectWorkspace({ workspaceId })
      if (isCurrentClickUpConnectionChange(generation)) {
        set(clickupStatusUpdate(contextKey, status, EMPTY_CLICKUP_READ_CACHES))
      }
    },

    disconnectClickUp: async (owner) => {
      const generation = beginClickUpConnectionChange()
      const contextKey = clickupOwnerContextKey(owner)
      const api = clickupApiForTarget(owner)
      await api.disconnect()
      const status = await api.status()
      if (isCurrentClickUpConnectionChange(generation)) {
        set(
          clickupStatusUpdate(contextKey, status, {
            clickupConnectionLost: false,
            ...EMPTY_CLICKUP_READ_CACHES
          })
        )
      }
    }
  }
}
