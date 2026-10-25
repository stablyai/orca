import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  remoteUpdateNeedsAttention,
  type AppUpdateBatch
} from '../../../../shared/app-update-batch'
import { hasReachedAppVersion } from '../../../../shared/app-version'
import {
  appUpdateRemoteEntry as asRemoteEntry,
  appUpdateCheckpoint as asCheckpoint,
  loadAppUpdateRecovery
} from '@/runtime/app-update-recovery'
import {
  discoverAppUpdateRemoteCandidates,
  downloadAppUpdate
} from '@/runtime/app-update-preparation'
import {
  confirmRemoteServerUpdate,
  runRemoteServerUpdate,
  type RemoteServerUpdateEntry
} from '@/runtime/remote-server-update-coordinator'
import { runRemoteServerUpdateBatch } from '@/runtime/remote-server-update-batch'
import {
  remoteServerUpdateTransport,
  remoteServerUpdateTransportForRevision
} from '@/runtime/remote-server-update-transport'

import type { AppUpdateSlice, AppUpdateDependencies } from './app-update-state'
export type { AppUpdateSlice } from './app-update-state'

export function createAppUpdateActions(
  set: (partial: Partial<AppUpdateSlice>) => void,
  get: () => AppUpdateSlice & AppUpdateDependencies
): AppUpdateSlice {
  let restored = false
  let checkpointWrites = Promise.resolve()
  const checkpoint = async () => {
    const batch = get().appUpdateBatch
    const write = checkpointWrites.then(() => window.api.ui.set({ appUpdateBatch: batch }))
    checkpointWrites = write.catch(() => undefined)
    await write
  }
  const changeBatch = (updates: Partial<AppUpdateBatch>) => {
    const batch = get().appUpdateBatch
    if (batch) {
      set({ appUpdateBatch: { ...batch, ...updates } })
    }
  }
  const progress = (entry: RemoteServerUpdateEntry) => {
    const batch = get().appUpdateBatch
    if (batch) {
      changeBatch({
        remotes: batch.remotes.map((remote) =>
          remote.environmentId === entry.environmentId ? asCheckpoint(entry) : remote
        )
      })
    }
  }
  const installLocal = async () => {
    const batch = get().appUpdateBatch
    const status = get().updateStatus
    if (!batch || status.state !== 'downloaded' || status.version !== batch.targetVersion) {
      throw new Error('The local update must finish downloading before Orca can restart.')
    }
    changeBatch({ stage: 'installing', error: null })
    await checkpoint()
    await window.api.updater.quitAndInstall()
  }
  const settle = async () => {
    const batch = get().appUpdateBatch
    if (!batch) {
      return
    }
    if (batch.remotes.some(remoteUpdateNeedsAttention)) {
      changeBatch({ stage: 'attention' })
      await checkpoint()
    } else {
      await installLocal()
    }
  }
  const run = async (operation: () => Promise<void>) => {
    if (get().appUpdateRunning) {
      return
    }
    set({ appUpdateRunning: true })
    try {
      await operation()
    } catch (error) {
      changeBatch({
        stage: 'attention',
        error: error instanceof Error ? error.message : String(error)
      })
      await checkpoint().catch(console.error)
    } finally {
      set({ appUpdateRunning: false })
    }
  }
  const downloadLocal = (version: string) =>
    downloadAppUpdate(version, () => get().updateStatus, remoteServerUpdateTransport)
  const runRemote = async (entry: RemoteServerUpdateEntry, prepareOnly: boolean) => {
    const result = await runRemoteServerUpdate(
      entry,
      remoteServerUpdateTransportForRevision(entry.pairingRevision),
      progress,
      {
        prepareOnly,
        freezeTarget: true,
        beforeInstall: async (next) => {
          const batch = get().appUpdateBatch
          const local = get().updateStatus
          const localVersion = get().appUpdateLocalVersion
          if (
            !batch ||
            !(
              (local.state === 'downloaded' && local.version === batch.targetVersion) ||
              (localVersion && hasReachedAppVersion(localVersion, batch.targetVersion))
            )
          ) {
            throw new Error('Download the app update before restarting a remote.')
          }
          progress(next)
          await checkpoint()
        }
      }
    )
    progress(result)
    await checkpoint()
  }
  const installReadyRemotes = () =>
    runRemoteServerUpdateBatch(
      get()
        .appUpdateBatch?.remotes.filter((remote) => remote.phase === 'ready')
        .map(asRemoteEntry) ?? [],
      2,
      (entry) => runRemote(entry, false)
    )
  return {
    appUpdateBatch: null,
    appUpdateRunning: false,
    appUpdateLocalVersion: null,
    appUpdateCandidates: [],
    appUpdateCandidatesChecking: false,
    appUpdateCandidatesVersion: null,
    discoverAppUpdateRemotes: async (version) => {
      if (
        get().appUpdateBatch ||
        get().appUpdateCandidatesChecking ||
        get().remoteServerUpdatesRunning ||
        get().remoteServerUpdatesChecking
      ) {
        return
      }
      set({ appUpdateCandidatesChecking: true })
      try {
        const entries = await discoverAppUpdateRemoteCandidates(version)
        set({ appUpdateCandidates: entries, appUpdateCandidatesVersion: version })
      } finally {
        set({ appUpdateCandidatesChecking: false })
      }
    },
    startAppUpdate: async () => {
      if (
        get().appUpdateBatch ||
        get().remoteServerUpdatesRunning ||
        get().remoteServerUpdatesChecking
      ) {
        return
      }
      const status = get().updateStatus
      if (status.state !== 'available' || status.externallyManaged) {
        return
      }
      if (get().appUpdateCandidatesVersion !== status.version) {
        await get().discoverAppUpdateRemotes(status.version)
      }
      if (get().appUpdateCandidatesVersion !== status.version) {
        return
      }
      await run(async () => {
        const entries = get().appUpdateCandidates.filter((entry) => entry.supportsPinnedInstall)
        set({
          appUpdateBatch: {
            version: 1,
            targetVersion: status.version,
            stage: 'preparing',
            remotes: entries.map(asCheckpoint),
            error: null
          }
        })
        await checkpoint()
        // Downloading locally and remotely is safe; all installs wait for the local package.
        const localDownload = downloadLocal(status.version)
        const remoteDownloads = runRemoteServerUpdateBatch(entries, 2, (entry) =>
          runRemote(entry, true)
        )
        const [localResult, remoteResult] = await Promise.allSettled([
          localDownload,
          remoteDownloads
        ])
        if (localResult.status === 'rejected') {
          throw localResult.reason
        }
        if (remoteResult.status === 'rejected') {
          throw remoteResult.reason
        }
        changeBatch({ stage: 'remotes' })
        await checkpoint()
        await installReadyRemotes()
        await settle()
      })
    },
    retryAppUpdateRemote: async (environmentId) => {
      await run(async () => {
        const batch = get().appUpdateBatch
        const remote = batch?.remotes.find((entry) => entry.environmentId === environmentId)
        if (!remote || !batch) {
          return
        }
        if (
          remote.phase === 'not-confirmed' ||
          remote.phase === 'verify-after-restart' ||
          remote.phase === 'restarting'
        ) {
          progress(
            await confirmRemoteServerUpdate(
              asRemoteEntry(remote),
              remoteServerUpdateTransportForRevision(remote.pairingRevision)
            )
          )
          await checkpoint()
        } else if (
          remote.phase === 'failed' ||
          remote.phase === 'ready' ||
          remote.phase === 'queued' ||
          remote.phase === 'downloading' ||
          remote.phase === 'checking-update'
        ) {
          await runRemote(asRemoteEntry(remote), true)
          const prepared = get().appUpdateBatch?.remotes.find(
            (entry) => entry.environmentId === environmentId
          )
          if (prepared?.phase === 'ready') {
            await runRemote(asRemoteEntry(prepared), false)
          }
        }
        if (batch.stage !== 'recovery') {
          await settle()
        }
      })
    },
    retryAppUpdateDownload: async () => {
      await run(async () => {
        const batch = get().appUpdateBatch
        if (!batch) {
          return
        }
        changeBatch({ stage: 'preparing', error: null })
        await downloadLocal(batch.targetVersion)
        changeBatch({ stage: 'remotes' })
        await installReadyRemotes()
        await settle()
      })
    },
    continueAppUpdate: () => run(installLocal),
    restoreAppUpdate: async () => {
      if (restored) {
        return
      }
      restored = true
      try {
        const recovery = await loadAppUpdateRecovery()
        if (!recovery || get().appUpdateBatch || get().appUpdateRunning) {
          return
        }
        await run(async () => {
          set(recovery)
          await checkpoint()
        })
      } catch (error) {
        restored = false
        console.error('[updates] Could not restore remote update recovery', error)
      }
    },
    dismissAppUpdateRecovery: async () => {
      const batch = get().appUpdateBatch
      if (
        get().appUpdateRunning ||
        !batch ||
        batch.stage !== 'recovery' ||
        !hasReachedAppVersion(get().appUpdateLocalVersion ?? '', batch.targetVersion)
      ) {
        return
      }
      set({ appUpdateBatch: null })
      await checkpoint()
    }
  }
}

export const createAppUpdateSlice: StateCreator<AppState, [], [], AppUpdateSlice> = (set, get) =>
  createAppUpdateActions(set, get)
