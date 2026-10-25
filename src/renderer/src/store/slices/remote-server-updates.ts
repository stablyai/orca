import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { isListedRemoteServer } from '../../../../shared/runtime-environments'
import type { UpdateCheckOptions } from '../../../../shared/update-status-types'
import { remoteServerUpdateTransportForRevision } from '@/runtime/remote-server-update-transport'
import {
  checkingRemoteServerUpdateEntry,
  confirmRemoteServerUpdate,
  inspectRemoteServerUpdate,
  runRemoteServerUpdate,
  type RemoteServerUpdateEntry
} from '@/runtime/remote-server-update-coordinator'
import { runRemoteServerUpdateBatch } from '@/runtime/remote-server-update-batch'

const MAX_CONCURRENT_REMOTE_SERVER_UPDATES = 2

export type RemoteServerUpdatesSlice = {
  remoteServerUpdates: Map<string, RemoteServerUpdateEntry>
  remoteServerUpdateCheckOptions: UpdateCheckOptions | null
  remoteServerUpdatesChecking: boolean
  remoteServerUpdatesRunning: boolean
  remoteServerUpdateDialogOpen: boolean
  remoteServerUpdatesLastCheckedAt: number | null
  setRemoteServerUpdateDialogOpen: (open: boolean, options?: UpdateCheckOptions) => void
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

  setRemoteServerUpdateDialogOpen: (open, options) =>
    set({
      remoteServerUpdateDialogOpen: open,
      ...(open
        ? options
          ? { remoteServerUpdateCheckOptions: options }
          : {}
        : { remoteServerUpdateCheckOptions: null })
    }),

  refreshRemoteServerUpdates: async (options) => {
    if (
      get().appUpdateBatch ||
      get().remoteServerUpdatesChecking ||
      get().remoteServerUpdatesRunning
    ) {
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
          const entry = await inspectRemoteServerUpdate(
            environment,
            clientVersion,
            remoteServerUpdateTransportForRevision(
              environment.pairingRevision ?? environment.createdAt
            ),
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
    if (get().appUpdateBatch || get().remoteServerUpdatesRunning) {
      return
    }
    const selected = new Set(environmentIds ?? [])
    const checkOptions = get().remoteServerUpdateCheckOptions
    const entries = [...get().remoteServerUpdates.values()].filter(
      (entry) =>
        (entry.phase === 'available' ||
          entry.phase === 'failed' ||
          entry.phase === 'not-confirmed' ||
          entry.phase === 'verify-after-restart') &&
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
          if (entry.phase === 'not-confirmed' || entry.phase === 'verify-after-restart') {
            const confirmed = await confirmRemoteServerUpdate(
              entry,
              remoteServerUpdateTransportForRevision(entry.pairingRevision)
            )
            set((state) => ({
              remoteServerUpdates: new Map(state.remoteServerUpdates).set(
                entry.environmentId,
                confirmed
              )
            }))
            return
          }
          await runRemoteServerUpdate(
            entry,
            remoteServerUpdateTransportForRevision(entry.pairingRevision),
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
