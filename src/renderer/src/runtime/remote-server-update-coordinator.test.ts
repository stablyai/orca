import { describe, expect, it } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'

import type { RemoteServerUpdaterSnapshot } from '../../../shared/remote-server-update'
import type { RemoteServerUpdateEntry } from './remote-server-update-coordinator'

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

const availableSnapshot: RemoteServerUpdaterSnapshot = {
  appVersion: '1.4.0',
  runtimeId: 'runtime-old',
  support: { installMode: 'supervised-headless-serve', automatic: true, reason: 'available' },
  status: { state: 'available', version: '1.5.0', changelog: null }
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

describe('remote server update execution', () => {
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
