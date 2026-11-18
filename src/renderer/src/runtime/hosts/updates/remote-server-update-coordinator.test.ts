import { describe, expect, it } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
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

describe('inspectRemoteServerUpdate', () => {
  it('names this app as behind when the server runs a newer version', async () => {
    const entry = await inspectRemoteServerUpdate(environment, '1.4.300', transportFor('1.4.302'))
    expect(entry).toMatchObject({ phase: 'current', newerThanClientVersion: '1.4.300' })
  })

  it('flags nothing when the server is the same version or older', async () => {
    const same = await inspectRemoteServerUpdate(environment, '1.4.300', transportFor('1.4.300'))
    const older = await inspectRemoteServerUpdate(environment, '1.4.300', transportFor('1.4.290'))
    expect(same).toMatchObject({ phase: 'current', newerThanClientVersion: null })
    expect(older).toMatchObject({ phase: 'manual', newerThanClientVersion: null })
  })
})
