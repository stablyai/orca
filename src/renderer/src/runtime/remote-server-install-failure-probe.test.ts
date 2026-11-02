import { describe, expect, it, vi } from 'vitest'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot
} from '../../../shared/remote-server-update'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { readRemoteServerInstallFailure } from './remote-server-install-failure-probe'

const support = {
  installMode: 'supervised-headless-serve',
  automatic: true,
  reason: 'available'
} as const

const install: RemoteServerUpdateInstallResult = {
  accepted: true,
  fromVersion: '1.4.0',
  targetVersion: '1.5.0',
  runtimeId: 'runtime-old'
}

function runtime(runtimeId = 'runtime-old'): RuntimeStatus {
  return {
    runtimeId,
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 2,
    liveLeafCount: 1,
    capabilities: ['updater.remote-control.v1'],
    appVersion: '1.4.0',
    remoteUpdateSupport: support
  }
}

function snapshot(
  status: RemoteServerUpdaterSnapshot['status'],
  runtimeId = 'runtime-old'
): RemoteServerUpdaterSnapshot {
  return { appVersion: '1.4.0', runtimeId, support, status }
}

describe('readRemoteServerInstallFailure', () => {
  it('returns the message the original process is publishing', async () => {
    const getUpdaterStatus = vi.fn(async () =>
      snapshot({ state: 'error', message: 'pkexec must be setuid root' })
    )

    await expect(
      readRemoteServerInstallFailure('server-1', { getUpdaterStatus }, install, runtime())
    ).resolves.toBe('pkexec must be setuid root')
  })

  it('bounds the status call by the deadline the caller passes', async () => {
    const getUpdaterStatus = vi.fn(async () =>
      snapshot({ state: 'error', message: 'pkexec must be setuid root' })
    )

    await readRemoteServerInstallFailure(
      'server-1',
      { getUpdaterStatus },
      install,
      runtime(),
      4_000
    )

    // Without this the call inherits the RPC client's 15s default and can outlast the reconnect budget.
    expect(getUpdaterStatus).toHaveBeenCalledWith('server-1', 4_000)
  })

  it('ignores an error published by a different process', async () => {
    const getUpdaterStatus = vi.fn(async () =>
      snapshot({ state: 'error', message: 'pkexec must be setuid root' }, 'runtime-new')
    )

    await expect(
      readRemoteServerInstallFailure('server-1', { getUpdaterStatus }, install, runtime())
    ).resolves.toBeNull()
  })

  it('ignores a snapshot that is not an error', async () => {
    const getUpdaterStatus = vi.fn(async () => snapshot({ state: 'downloaded', version: '1.5.0' }))

    await expect(
      readRemoteServerInstallFailure('server-1', { getUpdaterStatus }, install, runtime())
    ).resolves.toBeNull()
  })

  it('costs no round trip once the replacement runtime answers', async () => {
    const getUpdaterStatus = vi.fn(async () =>
      snapshot({ state: 'error', message: 'pkexec must be setuid root' })
    )

    await expect(
      readRemoteServerInstallFailure(
        'server-1',
        { getUpdaterStatus },
        install,
        runtime('runtime-new')
      )
    ).resolves.toBeNull()
    expect(getUpdaterStatus).not.toHaveBeenCalled()
  })
})
