import type { StateCreator } from 'zustand'
import type { PreflightStatus } from '../../../../preload/api-types'
import type { AppState } from '../types'

export type PreflightSlice = {
  preflightStatus: PreflightStatus | null
  preflightStatusChecked: boolean
  preflightStatusLoading: boolean
  preflightStatusError: string | null

  refreshPreflightStatus: (options?: { force?: boolean }) => Promise<void>
}

let nonForcedPreflightRequest: Promise<void> | null = null
let forcedPreflightRequest: Promise<void> | null = null
let latestPreflightRequestId = 0

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to check integrations.'
}

export const createPreflightSlice: StateCreator<AppState, [], [], PreflightSlice> = (set) => ({
  preflightStatus: null,
  preflightStatusChecked: false,
  preflightStatusLoading: false,
  preflightStatusError: null,

  refreshPreflightStatus: async (options) => {
    const force = options?.force === true
    if (!force && forcedPreflightRequest) {
      return forcedPreflightRequest
    }
    if (!force && nonForcedPreflightRequest) {
      return nonForcedPreflightRequest
    }

    const requestId = ++latestPreflightRequestId
    set({ preflightStatusLoading: true, preflightStatusError: null })

    const request = window.api.preflight
      .check(force ? { force: true } : undefined)
      .then((status) => {
        if (requestId !== latestPreflightRequestId) {
          return
        }
        set({
          preflightStatus: status,
          preflightStatusChecked: true,
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
          preflightStatusLoading: false,
          preflightStatusError: getErrorMessage(error)
        })
      })
      .finally(() => {
        if (!force && nonForcedPreflightRequest === request) {
          nonForcedPreflightRequest = null
        }
        if (force && forcedPreflightRequest === request) {
          forcedPreflightRequest = null
        }
      })

    if (!force) {
      nonForcedPreflightRequest = request
    } else {
      forcedPreflightRequest = request
    }

    return request
  }
})
