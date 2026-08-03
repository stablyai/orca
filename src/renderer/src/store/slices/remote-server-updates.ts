import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { RemoteServerUpdaterSnapshot } from '../../../../shared/remote-server-update'
import { isUserManagedRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { UpdateCheckOptions } from '../../../../shared/types'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-client'
import {
  checkingRemoteServerUpdateEntry,
  inspectRemoteServerUpdate,
  runRemoteServerUpdate,
  type RemoteServerUpdateEntry,
  type RemoteServerUpdateTransport
} from '@/runtime/remote-server-update-coordinator'
import { runRemoteServerUpdateBatch } from '@/runtime/remote-server-update-batch'

const MAX_CONCURRENT_REMOTE_SERVER_UPDATES = 2

function callRemoteUpdater<TResult>(
  environmentId: string,
  method: string,
  params?: unknown,
  timeoutMs = 15_000
): Promise<TResult> {
  return window.api.runtimeEnvironments
    .call({ selector: environmentId, method, params, timeoutMs })
    .then((response) => unwrapRuntimeRpcResult(response as RuntimeRpcResponse<TResult>))
}

const transport: RemoteServerUpdateTransport = {
  getRuntimeStatus: (environmentId, timeoutMs) =>
    window.api.runtimeEnvironments
      .getStatus({ selector: environmentId, timeoutMs })
      .then((response) => unwrapRuntimeRpcResult<RuntimeStatus>(response)),
  getUpdaterStatus: (environmentId) =>
    callRemoteUpdater<RemoteServerUpdaterSnapshot>(environmentId, 'updater.getStatus'),
  check: (environmentId, options) =>
    callRemoteUpdater<RemoteServerUpdaterSnapshot>(environmentId, 'updater.check', options),
  download: (environmentId) =>
    callRemoteUpdater<RemoteServerUpdaterSnapshot>(environmentId, 'updater.download'),
  install: (environmentId) => callRemoteUpdater(environmentId, 'updater.install'),
  wait: (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

export type RemoteServerUpdatesSlice = {
  remoteServerUpdates: Map<string, RemoteServerUpdateEntry>
  remoteServerUpdateCheckOptions: UpdateCheckOptions | null
  remoteServerUpdatesChecking: boolean
  remoteServerUpdatesRunning: boolean
  remoteServerUpdateDialogOpen: boolean
  remoteServerUpdatesLastCheckedAt: number | null
  setRemoteServerUpdateDialogOpen: (open: boolean) => void
  refreshRemoteServerUpdates: (options?: UpdateCheckOptions) => Promise<void>
  startRemoteServerUpdates: (environmentIds?: readonly string[]) => Promise<void>
}

export const createRemoteServerUpdatesSlice: StateCreator<
  AppState,
  [],
  [],
  RemoteServerUpdatesSlice
> = (set, get) => ({
  remoteServerUpdates: new Map(),
  remoteServerUpdateCheckOptions: null,
  remoteServerUpdatesChecking: false,
  remoteServerUpdatesRunning: false,
  remoteServerUpdateDialogOpen: false,
  remoteServerUpdatesLastCheckedAt: null,

  setRemoteServerUpdateDialogOpen: (open) =>
    set({
      remoteServerUpdateDialogOpen: open,
      ...(open ? {} : { remoteServerUpdateCheckOptions: null })
    }),

  refreshRemoteServerUpdates: async (options) => {
    if (get().remoteServerUpdatesChecking || get().remoteServerUpdatesRunning) {
      return
    }
    const checkOptions = options
      ? {
          includePrerelease: Boolean(options.includePrerelease),
          includePerfPrerelease: Boolean(options.includePerfPrerelease)
        }
      : undefined
    set({
      remoteServerUpdatesChecking: true,
      ...(checkOptions ? { remoteServerUpdateCheckOptions: checkOptions } : {})
    })
    try {
      const listed = await window.api.runtimeEnvironments.list()
      const environments = listed.filter(isUserManagedRuntimeEnvironment)
      get().setRuntimeEnvironments(listed)
      const previous = get().remoteServerUpdates
      const initial = new Map(
        environments.map((environment) => {
          const existing = previous.get(environment.id)
          return [
            environment.id,
            existing
              ? { ...existing, name: environment.name }
              : checkingRemoteServerUpdateEntry(environment)
          ]
        })
      )
      set({ remoteServerUpdates: initial })
      const clientVersion = await window.api.updater.getVersion()
      await Promise.allSettled(
        environments.map(async (environment) => {
          const entry = await inspectRemoteServerUpdate(
            environment,
            clientVersion,
            transport,
            checkOptions
          )
          set((state) => {
            const next = new Map(state.remoteServerUpdates)
            next.set(environment.id, entry)
            return { remoteServerUpdates: next }
          })
        })
      )
      set({ remoteServerUpdatesLastCheckedAt: Date.now() })
    } finally {
      set({ remoteServerUpdatesChecking: false })
    }
  },

  startRemoteServerUpdates: async (environmentIds) => {
    if (get().remoteServerUpdatesRunning) {
      return
    }
    const selected = new Set(environmentIds ?? [])
    const checkOptions = get().remoteServerUpdateCheckOptions
    const entries = [...get().remoteServerUpdates.values()].filter(
      (entry) =>
        (entry.phase === 'available' || entry.phase === 'failed') &&
        (selected.size === 0 || selected.has(entry.environmentId))
    )
    if (entries.length === 0) {
      return
    }
    set((state) => {
      const next = new Map(state.remoteServerUpdates)
      for (const entry of entries) {
        next.set(entry.environmentId, { ...entry, phase: 'queued', error: null })
      }
      return { remoteServerUpdates: next, remoteServerUpdatesRunning: true }
    })
    try {
      await runRemoteServerUpdateBatch(
        entries,
        MAX_CONCURRENT_REMOTE_SERVER_UPDATES,
        async (entry) => {
          await runRemoteServerUpdate(
            entry,
            transport,
            (progress) => {
              set((state) => {
                const next = new Map(state.remoteServerUpdates)
                next.set(entry.environmentId, progress)
                return { remoteServerUpdates: next }
              })
            },
            checkOptions ? { checkOptions } : undefined
          )
        }
      )
    } finally {
      set({ remoteServerUpdatesRunning: false, remoteServerUpdatesLastCheckedAt: Date.now() })
    }
  }
})
