import { describe, expect, it, vi } from 'vitest'
import {
  REMOTE_SERVER_UPDATE_CAPABILITY,
  type RemoteServerUpdaterSnapshot
} from '../../../../../shared/remote-runtime/host-catalog/remote-server-update'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { UpdateCheckOptions } from '../../../../../shared/updater/update-status-types'
import { getRemoteServerNewerThanClientVersion } from './remote-server-version-skew'
import {
  inspectRemoteServerUpdate,
  type RemoteServerUpdateTransport
} from './remote-server-update-coordinator'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inspection reads only id, name and orcadDeployment.
const environment = { id: 'env-1', name: 'Box' } as PublicKnownRuntimeEnvironment

function transportFor(
  appVersion: string,
  options?: {
    automatic?: boolean
    check?: (
      environmentId: string,
      checkOptions: UpdateCheckOptions
    ) => Promise<RemoteServerUpdaterSnapshot>
  }
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
        ...(options?.automatic
          ? {
              capabilities: [REMOTE_SERVER_UPDATE_CAPABILITY],
              remoteUpdateSupport: {
                installMode: 'interactive' as const,
                automatic: true,
                reason: 'available' as const
              }
            }
          : {})
      }) as RuntimeStatus,
    getUpdaterStatus: unused,
    check: options?.check ?? unused,
    download: unused,
    install: unused,
    wait: async () => {}
  }
}

function updaterSnapshot(
  appVersion: string,
  status: RemoteServerUpdaterSnapshot['status']
): RemoteServerUpdaterSnapshot {
  return {
    appVersion,
    runtimeId: 'r1',
    status,
    support: { installMode: 'interactive', automatic: true, reason: 'available' }
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

  it('marks a latest-stable automatic server as current when the client runs an hourly build', async () => {
    const check = vi.fn(async () => updaterSnapshot('1.4.263', { state: 'not-available' }))
    const entry = await inspectRemoteServerUpdate(
      environment,
      '1.4.264-hourly.202611181619',
      transportFor('1.4.263', { automatic: true, check })
    )

    expect(check).toHaveBeenCalledWith('env-1', {
      includePrerelease: false,
      includePerfPrerelease: false
    })
    expect(entry).toMatchObject({
      phase: 'current',
      currentVersion: '1.4.263',
      targetVersion: '1.4.263'
    })
  })

  it('offers the server feed version when an older server is inspected from a daily build', async () => {
    const check = vi.fn(async () =>
      updaterSnapshot('1.4.260', { state: 'available', version: '1.4.263', changelog: null })
    )
    const entry = await inspectRemoteServerUpdate(
      environment,
      '1.4.264-daily.202611180000',
      transportFor('1.4.260', { automatic: true, check })
    )

    expect(check).toHaveBeenCalledWith('env-1', {
      includePrerelease: false,
      includePerfPrerelease: false
    })
    expect(entry).toMatchObject({
      phase: 'available',
      currentVersion: '1.4.260',
      targetVersion: '1.4.263'
    })
  })

  it('preserves prerelease checking for an RC server inspected from an adhoc build', async () => {
    const check = vi.fn(async () =>
      updaterSnapshot('1.4.264-rc.1', {
        state: 'available',
        version: '1.4.264-rc.2',
        changelog: null
      })
    )
    const entry = await inspectRemoteServerUpdate(
      environment,
      '1.4.264-adhoc.20261118161905',
      transportFor('1.4.264-rc.1', { automatic: true, check })
    )

    expect(check).toHaveBeenCalledWith('env-1', {
      includePrerelease: true,
      includePerfPrerelease: false
    })
    expect(entry).toMatchObject({
      phase: 'available',
      currentVersion: '1.4.264-rc.1',
      targetVersion: '1.4.264-rc.2'
    })
  })

  it('does not mark a manual server as needing an hourly client build', async () => {
    const entry = await inspectRemoteServerUpdate(
      environment,
      '1.4.264-hourly.202611181619',
      transportFor('1.4.263')
    )

    expect(entry).toMatchObject({
      phase: 'current',
      currentVersion: '1.4.263',
      targetVersion: '1.4.263'
    })
  })
})
