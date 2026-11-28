import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { RemoteServerUpdaterSnapshot } from '../../../../../shared/remote-runtime/host-catalog/remote-server-update'
import { isListedRemoteServer } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeRpcResponse } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { UpdateCheckOptions } from '../../../../../shared/updater/update-status-types'
import { unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'
import {
  checkingRemoteServerUpdateEntry,
  inspectRemoteServerUpdate,
  runRemoteServerUpdate,
  type RemoteServerUpdateEntry,
  type RemoteServerUpdateTransport
} from '../../../../../shared/remote-runtime/host-updates/remote-server-update-coordinator'
import { remoteServerUpdateErrorMessage } from '@/runtime/hosts/updates/remote-server-update-errors'
import { runRemoteServerUpdateBatch } from '@/runtime/hosts/updates/remote-server-update-batch'
import {
  createRemoteServerUpdateWriteOrder,
  remoteServersToRecheck
} from './remote-server-update-write-order'

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
  getRuntimeStatus: (environmentId, timeoutMs, options) =>
    window.api.runtimeEnvironments
      .getStatus({ selector: environmentId, timeoutMs, ...options })
      .then((response) => unwrapRuntimeRpcResult<RuntimeStatus>(response)),
  getUpdaterStatus: (environmentId, timeoutMs) =>
    callRemoteUpdater<RemoteServerUpdaterSnapshot>(
      environmentId,
      'updater.getStatus',
      undefined,
      timeoutMs
    ),
  check: (environmentId, options) =>
    callRemoteUpdater<RemoteServerUpdaterSnapshot>(environmentId, 'updater.check', options),
  download: (environmentId) =>
    callRemoteUpdater<RemoteServerUpdaterSnapshot>(environmentId, 'updater.download'),
  install: (environmentId) => callRemoteUpdater(environmentId, 'updater.install'),
  wait: (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
  describeError: remoteServerUpdateErrorMessage
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
  /** Re-reads one server's update state, e.g. after it came back as a new runtime. */
  recheckRemoteServerUpdate: (environmentId: string) => Promise<void>
}

export const createRemoteServerUpdatesSlice: StateCreator<
  AppState,
  [],
  [],
  RemoteServerUpdatesSlice
> = (set, get, store) => {
  const writes = createRemoteServerUpdateWriteOrder()
  // Publishes a check's entry only if it is still the newest write and the server is still listed.
  const publishCheck = (environmentId: string, claim: number, entry: RemoteServerUpdateEntry) =>
    set((state) => {
      if (!writes.isLatest(environmentId, claim) || !state.remoteServerUpdates.has(environmentId)) {
        return {}
      }
      const next = new Map(state.remoteServerUpdates)
      next.set(environmentId, entry)
      return { remoteServerUpdates: next }
    })
  // Why: an update can land outside the update flow (Update anyway, a deferred update retried on
  // reconnect, one installed on the host); every surface reads this entry, so keep it current.
  let watching = false
  const watchRuntimeChanges = (): void => {
    if (watching) {
      return
    }
    watching = true
    store.subscribe((state, previous) => {
      if (state.runtimeStatusByEnvironmentId === previous.runtimeStatusByEnvironmentId) {
        return
      }
      for (const environmentId of remoteServersToRecheck(
        state.remoteServerUpdates,
        state.runtimeStatusByEnvironmentId,
        previous.runtimeStatusByEnvironmentId
      )) {
        void get().recheckRemoteServerUpdate(environmentId)
      }
    })
  }

  return {
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
      watchRuntimeChanges()
      set({
        remoteServerUpdatesChecking: true,
        ...(checkOptions ? { remoteServerUpdateCheckOptions: checkOptions } : {})
      })
      try {
        const listed = await window.api.runtimeEnvironments.list()
        const environments = listed.filter(isListedRemoteServer)
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
            const claim = writes.claim(environment.id)
            const entry = await inspectRemoteServerUpdate(
              environment,
              clientVersion,
              transport,
              checkOptions
            )
            publishCheck(environment.id, claim, entry)
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
          writes.claim(entry.environmentId)
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
                writes.claim(entry.environmentId)
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
    },

    recheckRemoteServerUpdate: async (environmentId) => {
      const environment = get().runtimeEnvironments.find((entry) => entry.id === environmentId)
      if (!environment || !get().remoteServerUpdates.has(environmentId)) {
        return
      }
      const claim = writes.claim(environmentId)
      const clientVersion = await window.api.updater.getVersion()
      const entry = await inspectRemoteServerUpdate(environment, clientVersion, transport)
      // An unreachable host proves nothing new; keep the entry and retry on the next contact change.
      if (entry.phase !== 'offline') {
        publishCheck(environmentId, claim, entry)
      }
    }
  }
}
