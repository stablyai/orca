import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveNodeDistMirrorAndRetry } from './node-dist-mirror-recovery'
import type { SshManagedServerStatus } from '../../../shared/ssh-types'
import { useAppStore } from '@/store'
import {
  beginSshConnect,
  endSshConnect,
  isSshConnectInFlight,
  resetSshConnectInFlightForTests
} from './ssh-connect-in-flight'

function setManagedServer(managedServer: SshManagedServerStatus): void {
  useAppStore.getState().setSshConnectionState('ssh-1', {
    targetId: 'ssh-1',
    status: managedServer.kind === 'managed' ? 'connected' : 'error',
    error: null,
    reconnectAttempt: 0,
    managedServer
  })
}

function deps() {
  const calls: string[] = []
  let finishConnect: () => void = () => {}
  return {
    calls,
    finishConnect: () => finishConnect(),
    save: vi.fn(async (url: string) => {
      calls.push(`save ${url}`)
    }),
    connect: vi.fn((targetId: string) => {
      calls.push(`connect ${targetId}`)
      return new Promise<void>((resolve) => {
        finishConnect = resolve
      })
    })
  }
}

afterEach(() => {
  resetSshConnectInFlightForTests()
  useAppStore.getState().clearRemovedSshTargetState('ssh-1')
})

describe('save a Node.js mirror and retry', () => {
  it('retries with the new mirror once a connect already dialing fails the same way', async () => {
    const d = deps()
    beginSshConnect('ssh-1')
    const result = await saveNodeDistMirrorAndRetry('ssh-1', 'https://mirror.example/node', d)
    expect(result.outcome).toBe('retrying')
    expect(d.calls).toEqual(['save https://mirror.example/node'])

    // The dialing connect misses the mirror and fails with the same blocked download.
    setManagedServer({
      kind: 'relay',
      reason: 'failed',
      nodeDownloadBlocked: { mirror: 'unset' }
    })
    endSshConnect('ssh-1')
    await vi.waitFor(() => expect(d.connect).toHaveBeenCalledWith('ssh-1'))
    expect(d.calls).toEqual(['save https://mirror.example/node', 'connect ssh-1'])
    expect(isSshConnectInFlight('ssh-1')).toBe(true)
  })

  it('does not reconnect when the connect already dialing succeeded', async () => {
    const d = deps()
    beginSshConnect('ssh-1')
    const result = await saveNodeDistMirrorAndRetry('ssh-1', 'https://mirror.example/node', d)
    setManagedServer({ kind: 'managed', environmentId: 'env-1' })
    endSshConnect('ssh-1')
    if (result.outcome === 'retrying') {
      await result.retry
    }
    expect(d.connect).not.toHaveBeenCalled()
  })
})
