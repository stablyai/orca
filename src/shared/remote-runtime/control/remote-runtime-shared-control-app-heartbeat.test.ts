import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SharedControlAppHeartbeat } from './remote-runtime-shared-control-app-heartbeat'
import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import { remoteRuntimeTimeoutError } from '../requests/remote-runtime-request-frames'
import type { RuntimeRpcResponse } from '../../runtime-rpc-envelope'

type Probe = (timeoutMs: number) => Promise<RuntimeRpcResponse<unknown>>

const ok: RuntimeRpcResponse<unknown> = {
  id: 'status.get',
  ok: true,
  result: {},
  _meta: { runtimeId: 'r' }
}

function setup(probe: Probe) {
  const onUnresponsive = vi.fn()
  const onRecovered = vi.fn()
  const probeSpy = vi.fn<Probe>(probe)
  const heartbeat = new SharedControlAppHeartbeat(
    { intervalMs: 1_000, timeoutMs: 500 },
    {
      probe: probeSpy,
      isCurrent: () => true,
      shouldProbe: () => true,
      onUnresponsive,
      onRecovered
    }
  )
  heartbeat.start(1)
  return { heartbeat, probe: probeSpy, onUnresponsive, onRecovered }
}

describe('shared control app heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never probes while the runtime keeps sending frames', async () => {
    const { heartbeat, probe } = setup(() => Promise.resolve(ok))
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(500)
      heartbeat.noteAnswer()
    }
    expect(probe).not.toHaveBeenCalled()
    heartbeat.stop()
  })

  it('reports a runtime that misses the probe deadline and clears it once it answers', async () => {
    let answer = false
    const { heartbeat, onUnresponsive, onRecovered } = setup((timeoutMs) =>
      answer
        ? Promise.resolve(ok)
        : new Promise((_, reject) =>
            setTimeout(() => reject(remoteRuntimeTimeoutError()), timeoutMs)
          )
    )
    // One silent interval sends the probe; its deadline then passes.
    await vi.advanceTimersByTimeAsync(1_000 + 500)
    expect(onUnresponsive).toHaveBeenCalledWith(1)
    const since = heartbeat.unresponsiveAt
    expect(since).not.toBeNull()

    // A reconnect starts a new socket; the mark survives until the runtime answers.
    heartbeat.start(2)
    expect(heartbeat.unresponsiveAt).toBe(since)
    answer = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onRecovered).toHaveBeenCalledTimes(1)
    expect(heartbeat.unresponsiveAt).toBeNull()
    heartbeat.stop()
  })

  it('clears the mark when a reconnected socket streams frames without needing a probe', async () => {
    const { heartbeat, onUnresponsive, onRecovered } = setup(
      (timeoutMs) =>
        new Promise((_, reject) => setTimeout(() => reject(remoteRuntimeTimeoutError()), timeoutMs))
    )
    await vi.advanceTimersByTimeAsync(1_500)
    expect(onUnresponsive).toHaveBeenCalledTimes(1)
    heartbeat.stop()
    // A handshake frame before the new socket is ready proves nothing.
    heartbeat.noteAnswer()
    expect(heartbeat.unresponsiveAt).not.toBeNull()
    heartbeat.start(2)
    heartbeat.noteAnswer()
    expect(heartbeat.unresponsiveAt).toBeNull()
    expect(onRecovered).toHaveBeenCalledTimes(1)
    heartbeat.stop()
  })

  it('does not blame the host for a deadline that fired late after this process slept', async () => {
    let now = 0
    let rejectProbe: (error: Error) => void = () => {}
    const onUnresponsive = vi.fn()
    const heartbeat = new SharedControlAppHeartbeat(
      { intervalMs: 1_000, timeoutMs: 500 },
      {
        probe: () => new Promise((_, reject) => (rejectProbe = reject)),
        isCurrent: () => true,
        shouldProbe: () => true,
        onUnresponsive,
        onRecovered: vi.fn(),
        now: () => now
      }
    )
    heartbeat.start(1)
    now = 1_000
    await vi.advanceTimersByTimeAsync(1_000)
    now = 60_000
    rejectProbe(remoteRuntimeTimeoutError())
    await vi.advanceTimersByTimeAsync(0)
    expect(onUnresponsive).not.toHaveBeenCalled()
    heartbeat.stop()
  })

  it('treats an error reply as an answer and a socket loss as neither', async () => {
    const errors = [
      new RemoteRuntimeClientError('method_not_found', 'old host'),
      new RemoteRuntimeClientError('runtime_unavailable', 'socket closed')
    ]
    const { heartbeat, onUnresponsive } = setup(() => Promise.reject(errors.shift()))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(onUnresponsive).not.toHaveBeenCalled()
    expect(heartbeat.unresponsiveAt).toBeNull()
    heartbeat.stop()
  })

  it('restarts the silence window after this process stalls instead of blaming the host', async () => {
    let now = 0
    const probe = vi.fn<Probe>(() => Promise.resolve(ok))
    const heartbeat = new SharedControlAppHeartbeat(
      { intervalMs: 1_000, timeoutMs: 500 },
      {
        probe,
        isCurrent: () => true,
        shouldProbe: () => true,
        onUnresponsive: vi.fn(),
        onRecovered: vi.fn(),
        now: () => now
      }
    )
    heartbeat.start(1)
    now = 10_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(probe).not.toHaveBeenCalled()
    now = 11_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(probe).toHaveBeenCalledTimes(1)
    heartbeat.stop()
  })

  it('discards a delayed policy check after replacing the ready socket', async () => {
    let release!: (allowed: boolean) => void
    const policy = new Promise<boolean>((resolve) => {
      release = resolve
    })
    const probe = vi.fn<Probe>(() => Promise.resolve(ok))
    let preparation = 0
    const heartbeat = new SharedControlAppHeartbeat(
      { intervalMs: 1_000, timeoutMs: 500 },
      {
        probe,
        isCurrent: () => true,
        shouldProbe: () => (++preparation === 1 ? policy : true),
        onUnresponsive: vi.fn(),
        onRecovered: vi.fn()
      }
    )
    heartbeat.start(1)
    await vi.advanceTimersByTimeAsync(1_000)
    heartbeat.start(2)
    release(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(probe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(probe).toHaveBeenCalledTimes(1)
    heartbeat.stop()
  })
})
