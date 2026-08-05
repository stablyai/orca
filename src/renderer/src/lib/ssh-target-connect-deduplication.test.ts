import { describe, expect, it, vi } from 'vitest'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { connectSshTargetDeduplicated } from './ssh-target-connect-deduplication'

const connectedState: SshConnectionState = {
  targetId: 'ssh-1',
  status: 'connected',
  error: null,
  reconnectAttempt: 0,
  remotePlatform: 'linux'
}

function controlledConnect(): {
  promise: Promise<SshConnectionState | null>
  resolve: (state: SshConnectionState | null) => void
  reject: (error: unknown) => void
} {
  let resolve!: (state: SshConnectionState | null) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<SshConnectionState | null>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

describe('connectSshTargetDeduplicated', () => {
  it('lets a pane reuse a pending startup connection', async () => {
    const pending = controlledConnect()
    const startupConnect = vi.fn(() => pending.promise)
    const paneConnect = vi.fn().mockRejectedValue(new Error('already in progress'))

    const startupAttempt = connectSshTargetDeduplicated('ssh-1', startupConnect)
    expect(startupConnect).toHaveBeenCalledOnce()
    const paneAttempt = connectSshTargetDeduplicated('ssh-1', paneConnect)

    expect(paneConnect).not.toHaveBeenCalled()
    expect(paneAttempt).toBe(startupAttempt)

    pending.resolve(connectedState)
    await expect(Promise.all([startupAttempt, paneAttempt])).resolves.toEqual([
      connectedState,
      connectedState
    ])

    const laterConnect = vi.fn().mockResolvedValue(connectedState)
    await expect(connectSshTargetDeduplicated('ssh-1', laterConnect)).resolves.toBe(connectedState)
    expect(laterConnect).toHaveBeenCalledOnce()
  })

  it('returns synchronous failures as rejected promises and cleans up for retry', async () => {
    const failure = new Error('Authentication failed')
    const failedConnect = vi.fn(() => {
      throw failure
    })

    const failedAttempt = connectSshTargetDeduplicated('ssh-failed', failedConnect)
    await expect(failedAttempt).rejects.toBe(failure)

    const retryConnect = vi.fn().mockResolvedValue({
      ...connectedState,
      targetId: 'ssh-failed'
    })
    await expect(connectSshTargetDeduplicated('ssh-failed', retryConnect)).resolves.toMatchObject({
      targetId: 'ssh-failed',
      status: 'connected'
    })
    expect(failedConnect).toHaveBeenCalledOnce()
    expect(retryConnect).toHaveBeenCalledOnce()
  })

  it('does not deduplicate different targets', async () => {
    const firstConnect = vi.fn().mockResolvedValue(connectedState)
    const secondConnect = vi.fn().mockResolvedValue({
      ...connectedState,
      targetId: 'ssh-2'
    })

    await Promise.all([
      connectSshTargetDeduplicated('ssh-1', firstConnect),
      connectSshTargetDeduplicated('ssh-2', secondConnect)
    ])

    expect(firstConnect).toHaveBeenCalledOnce()
    expect(secondConnect).toHaveBeenCalledOnce()
  })
})
