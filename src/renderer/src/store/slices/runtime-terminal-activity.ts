import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../../shared/runtime-types'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'

export type RuntimeTerminalActivityByWorktreeId = Record<string, true>

export type RuntimeTerminalActivitySlice = {
  runtimeTerminalActivityByWorktreeId: RuntimeTerminalActivityByWorktreeId
  runtimeTerminalActivityTargetKey: string | null
  runtimeTerminalActivityError: string | null
  refreshRuntimeTerminalActivity: () => Promise<void>
  clearRuntimeTerminalActivity: () => void
}

const RUNTIME_TERMINAL_ACTIVITY_LIST_LIMIT = 1000

function getRuntimeTerminalActivityTargetKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

export function buildRuntimeTerminalActivityByWorktreeId(
  terminals: readonly Pick<RuntimeTerminalSummary, 'worktreeId' | 'connected'>[]
): RuntimeTerminalActivityByWorktreeId {
  const next: RuntimeTerminalActivityByWorktreeId = {}
  for (const terminal of terminals) {
    const worktreeId = terminal.worktreeId.trim()
    if (terminal.connected && worktreeId) {
      next[worktreeId] = true
    }
  }
  return next
}

function areRuntimeTerminalActivityMapsEqual(
  a: RuntimeTerminalActivityByWorktreeId,
  b: RuntimeTerminalActivityByWorktreeId
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) {
    return false
  }
  return aKeys.every((key) => b[key])
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const createRuntimeTerminalActivitySlice: StateCreator<
  AppState,
  [],
  [],
  RuntimeTerminalActivitySlice
> = (set, get) => {
  let inFlightRefresh: {
    targetKey: string
    generation: number
    promise: Promise<void>
  } | null = null
  let refreshGeneration = 0
  let observedTargetKey: string | null = null

  return {
    runtimeTerminalActivityByWorktreeId: {},
    runtimeTerminalActivityTargetKey: null,
    runtimeTerminalActivityError: null,

    refreshRuntimeTerminalActivity: () => {
      const target = getActiveRuntimeTarget(get().settings)
      const targetKey = getRuntimeTerminalActivityTargetKey(target)
      if (observedTargetKey !== targetKey) {
        observedTargetKey = targetKey
        refreshGeneration += 1
      }
      const requestGeneration = refreshGeneration
      if (
        inFlightRefresh &&
        inFlightRefresh.targetKey === targetKey &&
        inFlightRefresh.generation === requestGeneration
      ) {
        return inFlightRefresh.promise
      }

      const request = (async () => {
        try {
          const result = await callRuntimeRpc<RuntimeTerminalListResult>(
            target,
            'terminal.list',
            { limit: RUNTIME_TERMINAL_ACTIVITY_LIST_LIMIT },
            { timeoutMs: 10_000, suppressFeatureInteraction: true }
          )
          const next = buildRuntimeTerminalActivityByWorktreeId(result.terminals)
          set((s) => {
            // Why: target switches and workspace-session resets can happen while
            // terminal.list is in flight; stale responses must not revive old PTYs.
            const activeTargetKey = getRuntimeTerminalActivityTargetKey(
              getActiveRuntimeTarget(s.settings)
            )
            if (refreshGeneration !== requestGeneration || activeTargetKey !== targetKey) {
              return {}
            }
            const activityChanged =
              s.runtimeTerminalActivityTargetKey !== targetKey ||
              !areRuntimeTerminalActivityMapsEqual(s.runtimeTerminalActivityByWorktreeId, next)
            return {
              ...(activityChanged
                ? {
                    runtimeTerminalActivityByWorktreeId: next,
                    runtimeTerminalActivityTargetKey: targetKey,
                    sortEpoch: s.sortEpoch + 1
                  }
                : {}),
              runtimeTerminalActivityError: null
            }
          })
        } catch (error) {
          set((s) => {
            const activeTargetKey = getRuntimeTerminalActivityTargetKey(
              getActiveRuntimeTarget(s.settings)
            )
            if (refreshGeneration !== requestGeneration || activeTargetKey !== targetKey) {
              return {}
            }
            const targetChanged = s.runtimeTerminalActivityTargetKey !== targetKey
            return {
              ...(targetChanged
                ? {
                    runtimeTerminalActivityByWorktreeId: {},
                    runtimeTerminalActivityTargetKey: targetKey,
                    sortEpoch: s.sortEpoch + 1
                  }
                : {}),
              runtimeTerminalActivityError: getErrorMessage(error)
            }
          })
        }
      })()

      const trackedRequest = request.finally(() => {
        if (inFlightRefresh?.promise === trackedRequest) {
          inFlightRefresh = null
        }
      })
      inFlightRefresh = {
        targetKey,
        generation: requestGeneration,
        promise: trackedRequest
      }
      return trackedRequest
    },

    clearRuntimeTerminalActivity: () => {
      refreshGeneration += 1
      observedTargetKey = null
      set((s) => {
        if (
          Object.keys(s.runtimeTerminalActivityByWorktreeId).length === 0 &&
          s.runtimeTerminalActivityTargetKey === null &&
          s.runtimeTerminalActivityError === null
        ) {
          return {}
        }
        return {
          runtimeTerminalActivityByWorktreeId: {},
          runtimeTerminalActivityTargetKey: null,
          runtimeTerminalActivityError: null,
          sortEpoch: s.sortEpoch + 1
        }
      })
    }
  }
}
