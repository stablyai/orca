import { expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { runRemoteServerAppVersionSync } from './remote-server-app-version-sync'
import type { RemoteServerUpdateEntry } from './remote-server-update-coordinator'

type ServerState = Pick<RemoteServerUpdateEntry, 'environmentId' | 'phase' | 'currentVersion'>

function createLaunchStore(servers: Map<string, string | null>) {
  const noStartedIds: readonly string[] = []
  const store = createStore(() => ({
    settings: {},
    remoteServerUpdatesChecking: false,
    remoteServerUpdatesRunning: false,
    remoteServerUpdateCheckOptions: null,
    remoteServerUpdateDialogOpen: false,
    setRemoteServerUpdateDialogOpen: () => {},
    remoteServerUpdates: new Map<string, ServerState>(),
    startedIds: noStartedIds,
    refreshRemoteServerUpdates: async () => {
      const entries = new Map<string, ServerState>()
      for (const [environmentId, currentVersion] of servers) {
        entries.set(environmentId, {
          environmentId,
          currentVersion,
          phase:
            currentVersion === null
              ? 'offline'
              : currentVersion === '1.4.262'
                ? 'available'
                : 'current'
        })
      }
      store.setState({ remoteServerUpdates: entries })
    },
    startRemoteServerUpdates: async (environmentIds: readonly string[]) => {
      for (const id of environmentIds) {
        servers.set(id, '1.4.263')
      }
      store.setState({ startedIds: environmentIds })
    }
  }))
  return store
}

it('retries a pending app update on the next launch for a server that was offline', async () => {
  vi.useFakeTimers()
  try {
    const saved = new Map([['orca.remoteServers.lastAppVersion', '1.4.262']])
    const pendingKey = 'orca.remoteServers.pendingAppVersion'
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value)
    }
    const servers = new Map<string, string | null>([
      ['online', '1.4.262'],
      ['offline', null]
    ])
    const getCurrentVersion = async () => '1.4.263'

    const firstStore = createLaunchStore(servers)
    const firstLaunch = runRemoteServerAppVersionSync({
      getCurrentVersion,
      storage,
      store: firstStore
    })
    await vi.runAllTimersAsync()
    await firstLaunch
    expect(firstStore.getState().startedIds).toEqual(['online'])
    expect(storage.getItem('orca.remoteServers.lastAppVersion')).toBe('1.4.263')
    expect(JSON.parse(storage.getItem(pendingKey) ?? 'null')).toEqual({
      version: '1.4.263',
      attempts: 1
    })

    servers.set('offline', '1.4.262')
    const secondStore = createLaunchStore(servers)
    await runRemoteServerAppVersionSync({ getCurrentVersion, storage, store: secondStore })
    expect(secondStore.getState().startedIds).toEqual(['offline'])
    expect(JSON.parse(storage.getItem(pendingKey) ?? 'null')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})
