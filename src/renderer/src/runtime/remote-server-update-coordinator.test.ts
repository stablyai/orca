import { describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot
} from '../../../shared/remote-server-update'
import {
  inspectRemoteServerUpdate,
  runRemoteServerUpdate,
  type RemoteServerUpdateEntry,
  type RemoteServerUpdateTransport
} from './remote-server-update-coordinator'
import { runRemoteServerUpdateBatch } from './remote-server-update-batch'

const environment: PublicKnownRuntimeEnvironment = {
  id: 'server-1',
  name: 'Build server',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: 'runtime-old',
  endpoints: [{ id: 'ws-1', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://server' }],
  preferredEndpointId: 'ws-1'
}

function status(version: string, runtimeId = 'runtime-old', automatic = true): RuntimeStatus {
  return {
    runtimeId,
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 2,
    liveLeafCount: 1,
    capabilities: automatic ? ['updater.remote-control.v1'] : [],
    appVersion: version,
    remoteUpdateSupport: automatic
      ? { installMode: 'supervised-headless-serve', automatic: true, reason: 'available' }
      : {
          installMode: 'unsupported-headless-serve',
          automatic: false,
          reason: 'manual-service-update-required'
        }
  }
}

const availableSnapshot: RemoteServerUpdaterSnapshot = {
  appVersion: '1.4.0',
  runtimeId: 'runtime-old',
  support: { installMode: 'supervised-headless-serve', automatic: true, reason: 'available' },
  status: { state: 'available', version: '1.5.0', changelog: null }
}

function transport(
  overrides: Partial<RemoteServerUpdateTransport> = {}
): RemoteServerUpdateTransport {
  let clock = 0
  return {
    getRuntimeStatus: vi.fn(async () => status('1.4.0')),
    getUpdaterStatus: vi.fn(async () => availableSnapshot),
    check: vi.fn(async () => availableSnapshot),
    download: vi.fn(async () => availableSnapshot),
    install: vi.fn(
      async (): Promise<RemoteServerUpdateInstallResult> => ({
        accepted: true,
        fromVersion: '1.4.0',
        targetVersion: '1.5.0',
        runtimeId: 'runtime-old'
      })
    ),
    wait: vi.fn(async (milliseconds) => {
      clock += milliseconds
    }),
    now: () => clock,
    ...overrides
  }
}

function availableEntry(): RemoteServerUpdateEntry {
  return {
    environmentId: environment.id,
    name: environment.name,
    phase: 'available',
    currentVersion: '1.4.0',
    targetVersion: '1.5.0',
    progress: null,
    runtimeId: 'runtime-old',
    liveTabCount: 2,
    liveLeafCount: 1,
    support: availableSnapshot.support,
    error: null
  }
}

describe('remote server update inventory', () => {
  it('classifies current, eligible, legacy, and offline servers', async () => {
    await expect(
      inspectRemoteServerUpdate(environment, '1.5.0', transport())
    ).resolves.toMatchObject({ phase: 'available', currentVersion: '1.4.0' })
    await expect(
      inspectRemoteServerUpdate(
        environment,
        '1.5.0',
        transport({ getRuntimeStatus: async () => status('1.5.1') })
      )
    ).resolves.toMatchObject({ phase: 'current', currentVersion: '1.5.1' })
    await expect(
      inspectRemoteServerUpdate(
        environment,
        '1.5.0',
        transport({ getRuntimeStatus: async () => status('1.4.0', 'runtime-old', false) })
      )
    ).resolves.toMatchObject({ phase: 'manual', currentVersion: '1.4.0' })
    await expect(
      inspectRemoteServerUpdate(
        environment,
        '1.5.0',
        transport({
          getRuntimeStatus: async () => {
            throw new Error('offline')
          }
        })
      )
    ).resolves.toMatchObject({ phase: 'offline', error: 'offline' })
  })

  it('checks the explicitly selected prerelease channel on the remote server', async () => {
    const check = vi.fn(async () => availableSnapshot)
    const result = await inspectRemoteServerUpdate(environment, '1.4.0', transport({ check }), {
      includePrerelease: false,
      includePerfPrerelease: true
    })

    expect(check).toHaveBeenCalledWith('server-1', {
      includePrerelease: false,
      includePerfPrerelease: true
    })
    expect(result).toMatchObject({ phase: 'available', targetVersion: '1.5.0' })
  })
})

describe('remote server update execution', () => {
  it('downloads, installs, and proves a replacement runtime reached the target', async () => {
    const snapshots = [
      availableSnapshot,
      { ...availableSnapshot, status: { state: 'downloading', percent: 45, version: '1.5.0' } },
      { ...availableSnapshot, status: { state: 'downloaded', version: '1.5.0' } }
    ] satisfies RemoteServerUpdaterSnapshot[]
    const progress: RemoteServerUpdateEntry[] = []
    const result = await runRemoteServerUpdate(
      availableEntry(),
      transport({
        getUpdaterStatus: async () => snapshots.shift() ?? availableSnapshot,
        getRuntimeStatus: async () => status('1.5.0', 'runtime-new')
      }),
      (entry) => progress.push(entry),
      { timing: { operationTimeoutMs: 10, reconnectTimeoutMs: 10, pollIntervalMs: 1 } }
    )

    expect(result).toMatchObject({ phase: 'updated', currentVersion: '1.5.0' })
    expect(progress.map((entry) => entry.phase)).toEqual([
      'checking-update',
      'downloading',
      'downloading',
      'restarting',
      'updated'
    ])
    expect(progress[2]?.progress).toBe(45)
  })

  it('fails when no offered update reaches the requested version', async () => {
    const noUpdate = { ...availableSnapshot, status: { state: 'not-available' } } as const
    const result = await runRemoteServerUpdate(
      availableEntry(),
      transport({ getUpdaterStatus: async () => noUpdate }),
      () => undefined,
      { timing: { operationTimeoutMs: 10, reconnectTimeoutMs: 10, pollIntervalMs: 1 } }
    )
    expect(result).toMatchObject({
      phase: 'failed',
      error: 'The server updater did not offer the requested Orca version.'
    })
  })

  it('requests prerelease updates when the active client is a prerelease', async () => {
    const check = vi.fn(async () => availableSnapshot)
    const entry = { ...availableEntry(), targetVersion: '1.5.0-rc.2' }
    await runRemoteServerUpdate(
      entry,
      transport({
        check,
        getUpdaterStatus: async () => ({
          ...availableSnapshot,
          status: { state: 'error', message: 'stop after check' }
        })
      }),
      () => undefined,
      { timing: { operationTimeoutMs: 10, reconnectTimeoutMs: 10, pollIntervalMs: 1 } }
    )
    expect(check).toHaveBeenCalledWith('server-1', {
      includePrerelease: true,
      includePerfPrerelease: false
    })
  })

  it('keeps stable client updates on the stable channel', async () => {
    const check = vi.fn(async () => availableSnapshot)
    await runRemoteServerUpdate(
      availableEntry(),
      transport({
        check,
        getUpdaterStatus: async () => ({
          ...availableSnapshot,
          status: { state: 'error', message: 'stop after check' }
        })
      }),
      () => undefined,
      { timing: { operationTimeoutMs: 10, reconnectTimeoutMs: 10, pollIntervalMs: 1 } }
    )
    expect(check).toHaveBeenCalledWith('server-1', {
      includePrerelease: false,
      includePerfPrerelease: false
    })
  })

  it('preserves an explicit perf-channel check through installation', async () => {
    const check = vi.fn(async () => availableSnapshot)
    await runRemoteServerUpdate(
      availableEntry(),
      transport({
        check,
        getUpdaterStatus: async () => ({
          ...availableSnapshot,
          status: { state: 'error', message: 'stop after check' }
        })
      }),
      () => undefined,
      { checkOptions: { includePrerelease: false, includePerfPrerelease: true } }
    )
    expect(check).toHaveBeenCalledWith('server-1', {
      includePrerelease: false,
      includePerfPrerelease: true
    })
  })

  it('surfaces updater errors and rejects a same-process restart', async () => {
    const updaterError = {
      ...availableSnapshot,
      status: { state: 'error', message: 'download failed' }
    } as const
    const failedDownload = await runRemoteServerUpdate(
      availableEntry(),
      transport({ getUpdaterStatus: async () => updaterError }),
      () => undefined,
      { timing: { operationTimeoutMs: 10, reconnectTimeoutMs: 10, pollIntervalMs: 1 } }
    )
    expect(failedDownload).toMatchObject({ phase: 'failed', error: 'download failed' })

    const snapshots = [
      availableSnapshot,
      { ...availableSnapshot, status: { state: 'downloaded', version: '1.5.0' } }
    ] satisfies RemoteServerUpdaterSnapshot[]
    const sameRuntime = await runRemoteServerUpdate(
      availableEntry(),
      transport({
        getUpdaterStatus: async () => snapshots.shift() ?? availableSnapshot,
        getRuntimeStatus: async () => status('1.5.0', 'runtime-old')
      }),
      () => undefined,
      { timing: { operationTimeoutMs: 10, reconnectTimeoutMs: 2, pollIntervalMs: 1 } }
    )
    expect(sameRuntime).toMatchObject({
      phase: 'failed',
      error: 'The server did not reconnect on the updated version.'
    })
  })

  it('turns a capability race into manual update guidance', async () => {
    const result = await runRemoteServerUpdate(
      availableEntry(),
      transport({
        check: async () => {
          throw new Error('remote_update_manual_required')
        }
      }),
      () => undefined
    )
    expect(result).toMatchObject({
      phase: 'failed',
      error: 'This server must be updated manually through its service manager.'
    })
  })

  it('bounds concurrent server replacement work', async () => {
    let active = 0
    let peak = 0
    const release: (() => void)[] = []
    const entries = Array.from({ length: 5 }, (_, index) => ({
      ...availableEntry(),
      environmentId: `server-${index}`
    }))
    const running = runRemoteServerUpdateBatch(entries, 2, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => release.push(resolve))
      active -= 1
    })
    while (release.length < 2) {
      await Promise.resolve()
    }
    while (release.length > 0) {
      release.shift()?.()
      await Promise.resolve()
    }
    await running
    expect(peak).toBe(2)
  })
})
