import {
  compareAppVersions,
  isValidAppVersion
} from '../../../../../shared/app-lifecycle/identity/app-version'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { UpdateCheckOptions } from '../../../../../shared/updater/update-status-types'
import type { RemoteServerUpdateEntry } from './remote-server-update-coordinator'

const LAST_APP_VERSION_KEY = 'orca.remoteServers.lastAppVersion'
const PENDING_APP_VERSION_KEY = 'orca.remoteServers.pendingAppVersion'
const MAX_ATTEMPTS = 3
const BUSY_TIMEOUT_MS = 60_000
const OFFLINE_RETRY_DELAY_MS = 10_000

type PendingSync = { version: string; attempts: number }
type SyncStorage = Pick<Storage, 'getItem' | 'setItem'>
type SyncState = {
  settings: Pick<GlobalSettings, 'updateRemoteServersWithApp'> | null
  remoteServerUpdatesChecking: boolean
  remoteServerUpdatesRunning: boolean
  remoteServerUpdateCheckOptions: UpdateCheckOptions | null
  remoteServerUpdates: ReadonlyMap<
    string,
    Pick<RemoteServerUpdateEntry, 'environmentId' | 'phase' | 'currentVersion'>
  >
  refreshRemoteServerUpdates: () => Promise<void>
  startRemoteServerUpdates: (environmentIds: readonly string[]) => Promise<void>
}
type SyncStore = {
  getState: () => SyncState
  subscribe: (listener: (state: SyncState) => void) => () => void
}
type SyncResult = 'complete' | 'retry' | 'skipped'

function readStorage(storage: SyncStorage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(storage: SyncStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value)
  } catch {
    // The renderer can run without access to localStorage.
  }
}

function readPendingSync(storage: SyncStorage): PendingSync | null {
  const raw = readStorage(storage, PENDING_APP_VERSION_KEY)
  if (raw === null) {
    return null
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (
      value &&
      typeof value === 'object' &&
      'version' in value &&
      typeof value.version === 'string' &&
      isValidAppVersion(value.version) &&
      'attempts' in value &&
      typeof value.attempts === 'number' &&
      Number.isInteger(value.attempts) &&
      value.attempts >= 0 &&
      value.attempts < MAX_ATTEMPTS
    ) {
      return { version: value.version, attempts: value.attempts }
    }
  } catch {
    return null
  }
  return null
}

function isOlderVersion(previousVersion: string | null, currentVersion: string): boolean {
  return (
    previousVersion !== null &&
    isValidAppVersion(previousVersion) &&
    isValidAppVersion(currentVersion) &&
    compareAppVersions(previousVersion, currentVersion) < 0
  )
}

function syncEnabled({ settings }: SyncState): boolean {
  return settings !== null && settings.updateRemoteServersWithApp !== false
}

function updatesBusy(state: SyncState): boolean {
  return state.remoteServerUpdatesChecking || state.remoteServerUpdatesRunning
}

function waitForIdle(store: SyncStore, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => finish(false), timeoutMs)
    const unsubscribe = store.subscribe((state) => {
      if (!updatesBusy(state)) {
        finish(true)
      }
    })
    function finish(idle: boolean): void {
      clearTimeout(timeout)
      unsubscribe()
      resolve(idle)
    }
  })
}

async function refreshWhenIdle(store: SyncStore): Promise<'refreshed' | 'retry' | 'skipped'> {
  const deadline = Date.now() + BUSY_TIMEOUT_MS
  while (updatesBusy(store.getState())) {
    const remaining = deadline - Date.now()
    if (remaining <= 0 || !(await waitForIdle(store, remaining))) {
      return syncEnabled(store.getState()) ? 'retry' : 'skipped'
    }
  }
  const state = store.getState()
  if (!syncEnabled(state)) {
    return 'skipped'
  }
  await state.refreshRemoteServerUpdates()
  return 'refreshed'
}

async function syncPendingVersion(store: SyncStore, version: string): Promise<SyncResult> {
  let refreshed = await refreshWhenIdle(store)
  if (refreshed !== 'refreshed') {
    return refreshed
  }
  if (
    [...store.getState().remoteServerUpdates.values()].some((entry) => entry.phase === 'offline')
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, OFFLINE_RETRY_DELAY_MS))
    refreshed = await refreshWhenIdle(store)
    if (refreshed !== 'refreshed') {
      return refreshed
    }
  }
  const state = store.getState()
  if (!syncEnabled(state)) {
    return 'skipped'
  }
  if (updatesBusy(state)) {
    return 'retry'
  }
  const availableIds = [...state.remoteServerUpdates.values()]
    .filter((entry) => entry.phase === 'available' && isOlderVersion(entry.currentVersion, version))
    .map((entry) => entry.environmentId)
  if (availableIds.length > 0) {
    if (state.remoteServerUpdateCheckOptions) {
      return 'retry'
    }
    await state.startRemoteServerUpdates(availableIds)
  }
  const remaining = [...store.getState().remoteServerUpdates.values()]
  return remaining.some((entry) => entry.phase === 'offline' || entry.phase === 'checking')
    ? 'retry'
    : 'complete'
}

export async function runRemoteServerAppVersionSync({
  getCurrentVersion,
  storage,
  store
}: {
  getCurrentVersion: () => Promise<string>
  storage: SyncStorage
  store: SyncStore
}): Promise<void> {
  const version = await getCurrentVersion()
  const previousVersion = readStorage(storage, LAST_APP_VERSION_KEY)
  let pending = readPendingSync(storage)
  if (isOlderVersion(previousVersion, version)) {
    pending = { version, attempts: 0 }
    writeStorage(storage, PENDING_APP_VERSION_KEY, JSON.stringify(pending))
  }
  writeStorage(storage, LAST_APP_VERSION_KEY, version)
  if (pending?.version !== version || !syncEnabled(store.getState())) {
    return
  }

  let result: SyncResult = 'retry'
  try {
    result = await syncPendingVersion(store, version)
  } finally {
    if (result !== 'skipped') {
      const attempts = pending.attempts + 1
      const next = result === 'retry' && attempts < MAX_ATTEMPTS ? { version, attempts } : null
      writeStorage(storage, PENDING_APP_VERSION_KEY, JSON.stringify(next))
    }
  }
}
