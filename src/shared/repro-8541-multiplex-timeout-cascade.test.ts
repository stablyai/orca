/**
 * Issue #8541 — All remote sessions time out simultaneously on reconnect
 * (single TCP / shared-control multiplexing cascade).
 *
 * 1. All RPC for a remote environment share one
 *    RemoteRuntimeSharedControlConnection (one WebSocket).
 * 2. requestSharedControl onTimeout calls handleSocketClosed → closeSocket →
 *    rejectAllSharedControlPendingRequests — every in-flight RPC fails at once.
 * 3. Message text matches the DevTools storm in the issue report.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/shared/repro-8541-multiplex-timeout-cascade.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeSharedControlSocketState,
  rejectAllSharedControlPendingRequests
} from './remote-runtime-shared-control-state'
import { requestSharedControl } from './remote-runtime-shared-control-requests'
import { remoteRuntimeTimeoutError } from './remote-runtime-request-frames'
import type { SharedControlPendingRequest } from './remote-runtime-shared-control-types'

const connectionSource = readFileSync(
  join(__dirname, 'remote-runtime-shared-control-connection.ts'),
  'utf8'
)
const requestsSource = readFileSync(
  join(__dirname, 'remote-runtime-shared-control-requests.ts'),
  'utf8'
)
const stateSource = readFileSync(join(__dirname, 'remote-runtime-shared-control-state.ts'), 'utf8')

describe('#8541 shared-control timeout cascade rejects all pending RPCs', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('wires single-request timeout to full socket teardown', () => {
    expect(connectionSource).toMatch(/onTimeout: \(error\) => this\.handleSocketClosed\(error\)/)
    expect(requestsSource).toMatch(
      /Remote Orca runtime did not answer in time; resetting the control connection/
    )
    expect(stateSource).toMatch(/rejectAllSharedControlPendingRequests/)
    // One class instance owns the pending map for the whole control plane
    expect(connectionSource).toMatch(
      /private readonly pendingRequests = new Map<string, SharedControlPendingRequest/
    )
  })

  it('one timeout error rejects every other pending request on the same connection', async () => {
    const pendingRequests = new Map<string, SharedControlPendingRequest<unknown>>()
    const rejects: Error[] = []

    for (let i = 0; i < 5; i++) {
      const id = `req-${i}`
      pendingRequests.set(id, {
        method: `session.ping.${i}`,
        resolve: () => {},
        reject: (err: Error) => {
          rejects.push(err)
        },
        timeout: setTimeout(() => {}, 60_000),
        refreshTimeoutOnKeepalive: false
      })
    }

    expect(pendingRequests.size).toBe(5)
    const cascadeError = remoteRuntimeTimeoutError()
    rejectAllSharedControlPendingRequests(pendingRequests, cascadeError)

    expect(pendingRequests.size).toBe(0)
    expect(rejects).toHaveLength(5)
    for (const err of rejects) {
      expect(err.message).toBe('Timed out waiting for the remote Orca runtime to respond.')
    }
  })

  it('closeSharedControlSocketState (handleSocketClosed path) cascades the same way', () => {
    const pendingRequests = new Map<string, SharedControlPendingRequest<unknown>>()
    const rejects: Error[] = []
    for (let i = 0; i < 3; i++) {
      pendingRequests.set(`s-${i}`, {
        method: 'worktree.list',
        resolve: () => {},
        reject: (err: Error) => rejects.push(err),
        timeout: setTimeout(() => {}, 60_000),
        refreshTimeoutOnKeepalive: false
      })
    }

    closeSharedControlSocketState({
      readyWaiters: [],
      pendingRequests,
      subscriptions: new Map(),
      socketCleanup: null,
      ws: null,
      error: remoteRuntimeTimeoutError()
    })

    expect(pendingRequests.size).toBe(0)
    expect(rejects).toHaveLength(3)
  })

  it('requestSharedControl timeout message matches issue second-wave reset text', async () => {
    vi.useFakeTimers()
    const pendingRequests = new Map<string, SharedControlPendingRequest<unknown>>()
    const onTimeout = vi.fn()
    const promise = requestSharedControl({
      pendingRequests,
      method: 'terminal.list',
      params: {},
      timeoutMs: 100,
      ensureReady: () => Promise.resolve(),
      send: () => {},
      onTimeout
    })

    const assertion = expect(promise).rejects.toMatchObject({
      message: 'Timed out waiting for the remote Orca runtime to respond.'
    })
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    expect(onTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Remote Orca runtime did not answer in time; resetting the control connection.'
      })
    )
  })
})
