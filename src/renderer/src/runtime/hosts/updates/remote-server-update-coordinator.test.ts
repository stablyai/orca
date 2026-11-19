import { describe, expect, it } from 'vitest'
import {
  REMOTE_SERVER_UPDATE_CAPABILITY,
  type RemoteServerUpdaterSnapshot,
  type RemoteServerUpdateSupport
} from '../../../../../shared/remote-runtime/host-catalog/remote-server-update'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type {
  UpdateCheckOptions,
  UpdateStatus
} from '../../../../../shared/updater/update-status-types'
import { getRemoteServerNewerThanClientVersion } from './remote-server-version-skew'
import {
  inspectRemoteServerUpdate,
  type RemoteServerUpdateTransport
} from './remote-server-update-coordinator'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inspection reads only id, name and orcadDeployment.
const environment = { id: 'env-1', name: 'Box' } as PublicKnownRuntimeEnvironment

function transportFor(appVersion: string): RemoteServerUpdateTransport {
  const unused = (): never => {
    throw new Error('not called')
  }
  return {
    getRuntimeStatus: async () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inspection reads only these status fields.
      ({ appVersion, runtimeId: 'r1', liveTabCount: 0, liveLeafCount: 0 }) as RuntimeStatus,
    getUpdaterStatus: unused,
    check: unused,
    download: unused,
    install: unused,
    wait: async () => {}
  }
}

const automaticSupport: RemoteServerUpdateSupport = {
  installMode: 'interactive',
  automatic: true,
  reason: 'available'
}

function updaterSnapshot(status: UpdateStatus): RemoteServerUpdaterSnapshot {
  return {
    appVersion: '1.4.263',
    runtimeId: 'r1',
    support: automaticSupport,
    status
  }
}

function automaticTransport(
  appVersion: string,
  check: RemoteServerUpdateTransport['check']
): RemoteServerUpdateTransport {
  const unused = (): never => {
    throw new Error('not called')
  }
  return {
    getRuntimeStatus: async () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inspection reads only these status fields.
      ({
        appVersion,
        runtimeId: 'r1',
        liveTabCount: 0,
        liveLeafCount: 0,
        capabilities: [REMOTE_SERVER_UPDATE_CAPABILITY],
        remoteUpdateSupport: automaticSupport
      }) as RuntimeStatus,
    getUpdaterStatus: unused,
    check,
    download: unused,
    install: unused,
    wait: async () => {}
  }
}

describe('inspectRemoteServerUpdate', () => {
  it('names this app as behind when the server runs a newer version, with no downgrade target', async () => {
    const entry = await inspectRemoteServerUpdate(environment, '1.4.300', transportFor('1.4.302'))
    expect(entry).toMatchObject({ phase: 'current', targetVersion: '1.4.302' })
    expect(getRemoteServerNewerThanClientVersion(entry)).toBe('1.4.300')
  })

  it('flags nothing when the server is the same version or older', async () => {
    const same = await inspectRemoteServerUpdate(environment, '1.4.300', transportFor('1.4.300'))
    const older = await inspectRemoteServerUpdate(environment, '1.4.300', transportFor('1.4.290'))
    expect(same.phase).toBe('current')
    expect(older).toMatchObject({ phase: 'manual', targetVersion: '1.4.300' })
    expect(getRemoteServerNewerThanClientVersion(same)).toBeNull()
    expect(getRemoteServerNewerThanClientVersion(older)).toBeNull()
  })

  it('follows the server version an update run leaves behind', async () => {
    const older = await inspectRemoteServerUpdate(environment, '1.4.300', transportFor('1.4.290'))
    expect(getRemoteServerNewerThanClientVersion({ ...older, currentVersion: '1.4.304' })).toBe(
      '1.4.300'
    )
  })

  it('does not offer an hourly client build when the stable server is already current', async () => {
    const checks: UpdateCheckOptions[] = []
    const entry = await inspectRemoteServerUpdate(
      environment,
      '1.4.264-hourly.202611181619',
      automaticTransport('1.4.263', async (_environmentId, options) => {
        checks.push(options)
        return updaterSnapshot({ state: 'not-available' })
      })
    )
    expect(entry).toMatchObject({ phase: 'current', targetVersion: '1.4.263' })
    expect(entry.targetVersion).not.toContain('hourly')
    expect(checks).toEqual([{ includePrerelease: false, includePerfPrerelease: false }])
  })

  it('offers only the stable release a behind server can install for an hourly client', async () => {
    const entry = await inspectRemoteServerUpdate(
      environment,
      '1.4.264-hourly.202611181619',
      automaticTransport('1.4.260', async () =>
        updaterSnapshot({
          state: 'available',
          version: '1.4.263',
          changelog: null
        })
      )
    )
    expect(entry).toMatchObject({ phase: 'available', targetVersion: '1.4.263' })
  })

  it('keeps the stable-client fast path when the server can install this app version', async () => {
    const entry = await inspectRemoteServerUpdate(
      environment,
      '1.4.300',
      automaticTransport('1.4.290', async () => {
        throw new Error('stable client must not ask the server')
      })
    )
    expect(entry).toMatchObject({ phase: 'available', targetVersion: '1.4.300' })
  })

  it('keeps an RC client on this app version instead of the stable feed', async () => {
    const entry = await inspectRemoteServerUpdate(
      environment,
      '1.4.300-rc.1',
      automaticTransport('1.4.290', async () => {
        throw new Error('rc client must not ask the stable feed')
      })
    )
    expect(entry).toMatchObject({ phase: 'available', targetVersion: '1.4.300-rc.1' })
  })
})
