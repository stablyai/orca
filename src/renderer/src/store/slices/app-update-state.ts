import type { AppState } from '../types'
import type { AppUpdateBatch } from '../../../../shared/app-update-batch'
import type { RemoteServerUpdateEntry } from '@/runtime/remote-server-update-coordinator'

export type AppUpdateSlice = {
  appUpdateBatch: AppUpdateBatch | null
  appUpdateLocalVersion: string | null
  appUpdateRunning: boolean
  appUpdateCandidates: RemoteServerUpdateEntry[]
  appUpdateCandidatesChecking: boolean
  appUpdateCandidatesVersion: string | null
  discoverAppUpdateRemotes: (version: string) => Promise<void>
  startAppUpdate: () => Promise<void>
  retryAppUpdateRemote: (environmentId: string) => Promise<void>
  retryAppUpdateDownload: () => Promise<void>
  continueAppUpdate: () => Promise<void>
  restoreAppUpdate: () => Promise<void>
  dismissAppUpdateRecovery: () => Promise<void>
}

export type AppUpdateDependencies = Pick<
  AppState,
  'updateStatus' | 'remoteServerUpdatesRunning' | 'remoteServerUpdatesChecking'
>
