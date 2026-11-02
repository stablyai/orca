import type { StateCreator } from 'zustand'
import type { PreflightRuntimeContext, PreflightStatus } from '../../../../preload/api-types'
import type { AppState } from '../types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { defaultScopeHost } from '@/lib/default-creation-host'
import { getActiveWorkspaceOwnerTarget } from '@/lib/resolved-worktree-execution-host'
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

  /** `wakeWslDistro`: a user act (window focus, a click) that may start the focused workspace's stopped WSL distro. */
  refreshPreflightStatus: (options?: { force?: boolean; wakeWslDistro?: boolean }) => Promise<void>
  invalidatePreflightStatus: () => void
}

let nonForcedPreflightRequest: { key: string; promise: Promise<void> } | null = null
let forcedPreflightRequest: { key: string; promise: Promise<void>; wake: boolean } | null = null
let latestPreflightRequestId = 0

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to check integrations.'
}

function buildPreflightArgs(
  force: boolean,
  wake: boolean,
  context: LocalPreflightContext
): (PreflightRuntimeContext & { force?: boolean; wakeWslDistro?: boolean }) | undefined {
  const wslDistro = context?.wslDistro
  const wslDefault = context?.wslDefault === true
  const projectRuntime = context?.projectRuntime
  if (!force && !wslDistro && !wslDefault && !projectRuntime) {
    return undefined
  }
  // Only a focused WSL workspace's own distro may wake; a native workspace wakes nothing.
  const wslWorkspace =
    Boolean(wslDistro) ||
    (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl')
  return {
    ...(force ? { force: true } : {}),
    ...(wake && wslWorkspace ? { wakeWslDistro: true } : {}),
    ...(projectRuntime ? { projectRuntime } : {}),
    ...(wslDistro ? { wslDistro } : {}),
    ...(wslDefault ? { wslDefault: true } : {})
  }
}

export const createPreflightSlice: StateCreator<AppState, [], [], PreflightSlice> = (set, get) => ({
  preflightStatus: null,
  preflightStatusChecked: false,
  preflightStatusContextKey: null,
  preflightStatusLoading: false,
  preflightStatusError: null,

  invalidatePreflightStatus: () => {
    latestPreflightRequestId += 1
    nonForcedPreflightRequest = null
    forcedPreflightRequest = null
    set({
      preflightStatus: null,
      preflightStatusChecked: false,
      preflightStatusContextKey: null,
      preflightStatusLoading: false,
      preflightStatusError: null
    })
  },

  refreshPreflightStatus: async (options) => {
    const force = options?.force === true
    const wake = options?.wakeWslDistro === true
    const context = getLocalPreflightContext(get())
    const contextKey = localPreflightContextKey(context)
    if (!force && forcedPreflightRequest?.key === contextKey) {
      return forcedPreflightRequest.promise
    }
    if (!force && nonForcedPreflightRequest?.key === contextKey) {
      return nonForcedPreflightRequest.promise
    }
    // A background probe in flight may be refused for a stopped distro; a wake must not join it.
    if (
      force &&
      forcedPreflightRequest?.key === contextKey &&
      (forcedPreflightRequest.wake || !wake)
    ) {
      return forcedPreflightRequest.promise
    }

    const requestId = ++latestPreflightRequestId
    const contextChanged = get().preflightStatusContextKey !== contextKey
    // Why: the host the context key names: the focused workspace's owner, else the default scope host.
    const runtimeTarget = getActiveWorkspaceOwnerTarget(get()) ?? defaultScopeHost(get().settings)
    const preflightArgs = buildPreflightArgs(force, wake, context)
    set({
      preflightStatus: contextChanged ? null : get().preflightStatus,
      preflightStatusChecked: contextChanged ? false : get().preflightStatusChecked,
      preflightStatusLoading: true,
      preflightStatusError: null
    })

    const localPreflightCheck = window.api?.preflight?.check
    const request = (
      runtimeTarget.kind === 'environment'
        ? callRuntimeRpc<PreflightStatus>(runtimeTarget, 'preflight.check', force ? { force } : {})
        : localPreflightCheck
          ? localPreflightCheck(preflightArgs)
          : Promise.reject(new Error('Desktop preflight API is unavailable.'))
    )
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
      forcedPreflightRequest = { key: contextKey, promise: request, wake }
    }

    return request
  }
})
