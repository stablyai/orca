import type { StateCreator } from 'zustand'
import type { PreflightStatus } from '../../../../preload/api-types'
import type { AppState } from '../types'
import {
  getLocalPreflightContext,
  localPreflightContextKey,
  type LocalPreflightContext
} from '@/lib/local-preflight-context'

export type PreflightSlice = {
  preflightStatus: PreflightStatus | null
  preflightStatusChecked: boolean
  preflightStatusContextKey: string | null
  preflightStatusLoading: boolean
  preflightStatusError: string | null

  refreshPreflightStatus: (options?: { force?: boolean }) => Promise<void>
}

let nonForcedPreflightRequest: { key: string; promise: Promise<void> } | null = null
let forcedPreflightRequest: { key: string; promise: Promise<void> } | null = null
let latestPreflightRequestId = 0

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to check integrations.'
}

function buildPreflightArgs(
  force: boolean,
  context: LocalPreflightContext
): { force?: boolean; wslDistro?: string | null } | undefined {
  if (!force && !context) {
    return undefined
  }
  return {
    ...(force ? { force: true } : {}),
    ...context
  }
}

export const createPreflightSlice: StateCreator<AppState, [], [], PreflightSlice> = (set, get) => ({
  preflightStatus: null,
  preflightStatusChecked: false,
  preflightStatusContextKey: null,
  preflightStatusLoading: false,
  preflightStatusError: null,

  refreshPreflightStatus: async (options) => {
    const force = options?.force === true
    const context = getLocalPreflightContext(get())
    const contextKey = localPreflightContextKey(context)
    if (!force && forcedPreflightRequest?.key === contextKey) {
      return forcedPreflightRequest.promise
    }
    if (!force && nonForcedPreflightRequest?.key === contextKey) {
      return nonForcedPreflightRequest.promise
    }
    if (force && forcedPreflightRequest?.key === contextKey) {
      return forcedPreflightRequest.promise
    }

    const requestId = ++latestPreflightRequestId
    const contextChanged = get().preflightStatusContextKey !== contextKey
    set({
      preflightStatus: contextChanged ? null : get().preflightStatus,
      preflightStatusChecked: contextChanged ? false : get().preflightStatusChecked,
      preflightStatusLoading: true,
      preflightStatusError: null
    })

    const request = window.api.preflight
      .check(buildPreflightArgs(force, context))
      .then((status) => {
        if (requestId !== latestPreflightRequestId) {
          return
        }
        set({
          preflightStatus: status,
          preflightStatusChecked: true,
          preflightStatusContextKey: contextKey,
          preflightStatusLoading: false,
          preflightStatusError: null
        })
      })
      .catch((error) => {
        if (requestId !== latestPreflightRequestId) {
          return
        }
        set({
          preflightStatusChecked: true,
          preflightStatusContextKey: contextKey,
          preflightStatusLoading: false,
          preflightStatusError: getErrorMessage(error)
        })
      })
      .finally(() => {
        if (!force && nonForcedPreflightRequest?.promise === request) {
          nonForcedPreflightRequest = null
        }
        if (force && forcedPreflightRequest?.promise === request) {
          forcedPreflightRequest = null
        }
      })

    if (!force) {
      nonForcedPreflightRequest = { key: contextKey, promise: request }
    } else {
      forcedPreflightRequest = { key: contextKey, promise: request }
    }

    return request
  }
})
