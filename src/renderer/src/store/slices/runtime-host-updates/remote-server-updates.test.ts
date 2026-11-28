import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { REMOTE_SERVER_UPDATE_CAPABILITY } from '../../../../../shared/remote-runtime/host-catalog/remote-server-update'
import type { RuntimeEnvironmentStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { getRuntimeServerProblemLine } from '@/components/settings/runtime-environments/server-rows/runtime-server-row-meta'
import { getRuntimeServerVersionText } from '@/components/settings/runtime-environments/server-rows/runtime-server-row-presentation'
import { createTestStore } from '../../testing/app-store-test-fixture'

const ID = 'env-test'
const APP_VERSION = '1.3.0'

const SERVER: PublicKnownRuntimeEnvironment = {
  id: ID,
  name: 'example-server',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [
    { id: 'ws', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://192.0.2.50:6768' }
  ],
  preferredEndpointId: 'ws'
}

type Host = { runtimeId: string; appVersion: string; updater?: boolean }

function runtimeStatus({ runtimeId, appVersion, updater = false }: Host): RuntimeStatus {
  const { result } = createCompatibleRuntimeStatusResponse(runtimeId)
  return updater
    ? {
        ...result,
        appVersion,
        capabilities: [...(result.capabilities ?? []), REMOTE_SERVER_UPDATE_CAPABILITY],
        remoteUpdateSupport: { installMode: 'interactive', automatic: true, reason: 'available' }
      }
    : { ...result, appVersion }
}

/** status.get answers, released by the test so their order is explicit. */
const statusReads: { host: Host | Error; release: () => void }[] = []
let listed: PublicKnownRuntimeEnvironment[] = [SERVER]

function answerStatus(host: Host | Error): Promise<unknown> {
  return new Promise((resolve, reject) => {
    statusReads.push({
      host,
      release: () =>
        host instanceof Error
          ? reject(host)
          : resolve({ id: 'status', ok: true, result: runtimeStatus(host) })
    })
  })
}

/** The next status.get answer; held until released. */
let nextHost: Host | Error = { runtimeId: 'runtime-old', appVersion: '1.2.0' }

beforeEach(() => {
  statusReads.length = 0
  listed = [SERVER]
  nextHost = { runtimeId: 'runtime-old', appVersion: '1.2.0' }
  vi.stubGlobal('window', {
    setTimeout: (callback: () => void) => setTimeout(callback, 0),
    api: {
      runtimeEnvironments: {
        list: async () => listed,
        getStatus: () => answerStatus(nextHost),
        // The host's updater refuses, so an Update attempt fails.
        call: async () => ({
          id: 'updater',
          ok: false,
          error: { code: 'remote_update_failed', message: 'Download failed' }
        })
      },
      updater: { getVersion: async () => APP_VERSION }
    }
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

async function releaseAll(): Promise<void> {
  while (statusReads.some((read) => read.release !== noop)) {
    for (const read of statusReads) {
      const { release } = read
      read.release = noop
      release()
    }
    await flush()
  }
}
const noop = (): void => {}

function hostAnswers(runtimeId: string | null): RuntimeEnvironmentStatus {
  return {
    status:
      runtimeId === null ? null : runtimeStatus({ runtimeId, appVersion: 'reported-elsewhere' }),
    checkedAt: 1
  }
}

function publishHost(store: ReturnType<typeof createTestStore>, runtimeId: string | null): void {
  store.setState({ runtimeStatusByEnvironmentId: new Map([[ID, hostAnswers(runtimeId)]]) })
}

/** What the settings row shows for this server, read from the shared entry. */
function rowLine(store: ReturnType<typeof createTestStore>): string | null {
  const remoteUpdate = store.getState().remoteServerUpdates.get(ID)
  const problem = getRuntimeServerProblemLine({
    environment: { lastUsedAt: null },
    row: {
      accessRevoked: false,
      serverReplaced: false,
      problem: null,
      probeFailed: false,
      compatibilityBlocked: false
    },
    remoteUpdate,
    managedStatusError: null,
    managedSummary: null,
    address: '192.0.2.50:6768'
  })
  return problem?.text ?? getRuntimeServerVersionText(remoteUpdate, null)
}

async function refreshed(host: Host): Promise<ReturnType<typeof createTestStore>> {
  const store = createTestStore()
  publishHost(store, host.runtimeId)
  nextHost = host
  const refresh = store.getState().refreshRemoteServerUpdates()
  await flush()
  await releaseAll()
  await refresh
  return store
}

describe('remote server update entries follow the host', () => {
  it('returns every surface to the version once the host comes back updated', async () => {
    const store = await refreshed({ runtimeId: 'runtime-old', appVersion: '1.2.0' })
    expect(store.getState().remoteServerUpdates.get(ID)?.phase).toBe('manual')
    expect(rowLine(store)).toBe('Update Orca on the server host')

    nextHost = { runtimeId: 'runtime-new', appVersion: APP_VERSION }
    publishHost(store, 'runtime-new')
    await flush()
    await releaseAll()

    expect(store.getState().remoteServerUpdates.get(ID)).toMatchObject({
      phase: 'current',
      currentVersion: APP_VERSION,
      runtimeId: 'runtime-new'
    })
    expect(rowLine(store)).toBe(`v${APP_VERSION}`)
    // A second consumer of the same entry: Update all has nothing left to start.
    await store.getState().startRemoteServerUpdates()
    expect(store.getState().remoteServerUpdates.get(ID)?.phase).toBe('current')
    expect(store.getState().remoteServerUpdatesRunning).toBe(false)
  })

  it('keeps a newer failure when an older check answers after it', async () => {
    const updater = { updater: true, appVersion: '1.2.0' }
    const store = await refreshed({ runtimeId: 'runtime-old', ...updater })
    expect(store.getState().remoteServerUpdates.get(ID)?.phase).toBe('available')

    // A re-check samples the host as at-target, but its answer is held.
    nextHost = { runtimeId: 'runtime-new', ...updater, appVersion: APP_VERSION }
    publishHost(store, 'runtime-new')
    await flush()
    const heldCheck = statusReads.at(-1)
    expect(heldCheck).toBeDefined()

    // The Update runs and fails meanwhile.
    const held = heldCheck!.release
    heldCheck!.release = noop
    await store.getState().startRemoteServerUpdates([ID])
    expect(store.getState().remoteServerUpdates.get(ID)?.phase).toBe('failed')
    expect(rowLine(store)).toBe('Update failed')

    held()
    await flush()
    expect(store.getState().remoteServerUpdates.get(ID)?.phase).toBe('failed')
    expect(rowLine(store)).toBe('Update failed')
  })

  it('drops a check that began before the server was removed and added again', async () => {
    const store = await refreshed({ runtimeId: 'runtime-old', appVersion: '1.2.0' })
    nextHost = { runtimeId: 'runtime-new', appVersion: APP_VERSION }
    publishHost(store, 'runtime-new')
    await flush()
    const stale = statusReads.at(-1)!
    const staleRelease = stale.release
    stale.release = noop

    // Removed: the next refresh lists nothing.
    listed = []
    await store.getState().refreshRemoteServerUpdates()
    staleRelease()
    await flush()
    expect(store.getState().remoteServerUpdates.has(ID)).toBe(false)

    // Added again: its own check decides, not the one held from before.
    listed = [SERVER]
    nextHost = { runtimeId: 'runtime-new', appVersion: '1.2.5' }
    const refresh = store.getState().refreshRemoteServerUpdates()
    await flush()
    await releaseAll()
    await refresh
    expect(store.getState().remoteServerUpdates.get(ID)).toMatchObject({
      phase: 'manual',
      currentVersion: '1.2.5'
    })
  })

  it('treats lost contact as no evidence and checks again when contact returns', async () => {
    const store = await refreshed({ runtimeId: 'runtime-old', appVersion: '1.2.0' })
    const reads = statusReads.length

    publishHost(store, null)
    await flush()
    expect(statusReads).toHaveLength(reads)

    // The host answers, but the check can't reach it: the entry stays as it was.
    nextHost = new Error('connection lost')
    publishHost(store, 'runtime-new')
    await flush()
    await releaseAll()
    expect(statusReads).toHaveLength(reads + 1)
    expect(store.getState().remoteServerUpdates.get(ID)?.phase).toBe('manual')

    // Same host status again is not a contact change.
    publishHost(store, 'runtime-new')
    await flush()
    expect(statusReads).toHaveLength(reads + 1)

    publishHost(store, null)
    nextHost = { runtimeId: 'runtime-new', appVersion: APP_VERSION }
    publishHost(store, 'runtime-new')
    await flush()
    await releaseAll()
    expect(store.getState().remoteServerUpdates.get(ID)?.phase).toBe('current')
  })

  it('re-derives an updated entry from the host once it runs as another runtime', async () => {
    const store = await refreshed({ runtimeId: 'runtime-old', appVersion: APP_VERSION })
    store.setState({
      remoteServerUpdates: new Map([
        [
          ID,
          {
            ...store.getState().remoteServerUpdates.get(ID)!,
            phase: 'updated',
            runtimeId: 'runtime-updated'
          }
        ]
      ])
    })
    // The update's own runtime: nothing to re-check.
    publishHost(store, 'runtime-updated')
    await flush()
    const reads = statusReads.length
    // Rolled back by hand on the host.
    nextHost = { runtimeId: 'runtime-rolled-back', appVersion: '1.2.0' }
    publishHost(store, 'runtime-rolled-back')
    await flush()
    await releaseAll()
    expect(statusReads).toHaveLength(reads + 1)
    expect(store.getState().remoteServerUpdates.get(ID)).toMatchObject({
      phase: 'manual',
      currentVersion: '1.2.0'
    })
  })
})
