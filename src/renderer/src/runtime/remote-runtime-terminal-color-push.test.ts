import { describe, expect, it, vi } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { TerminalOscColorQueryReplyColors } from '../../../shared/terminal-osc-color-reply'
import { createRemoteRuntimeTerminalColorPush } from './remote-runtime-terminal-color-push'
import { RuntimeRpcCallError } from './runtime-rpc-client'

const DARK = { foreground: '#ffffff', background: '#282c34' }
const LIGHT = { foreground: '#2e3434', background: '#ffffff' }

function snapshot(
  environmentId: string,
  overrides: Partial<RuntimeHostStatusSnapshot> & { runtimeId?: string } = {}
): RuntimeHostStatusSnapshot {
  const { runtimeId = `${environmentId}-runtime`, ...rest } = overrides
  const status: RuntimeStatus = {
    runtimeId,
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  }
  return {
    environmentId,
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 0,
    status,
    verification: 'verified',
    transport: 'ready',
    ...rest
  }
}

function methodNotFound(): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: 'x',
    ok: false,
    error: { code: 'method_not_found', message: 'Unknown method' }
  })
}

function harness() {
  const calls: [string, TerminalOscColorQueryReplyColors][] = []
  const call = vi.fn(async (environmentId: string, colors: TerminalOscColorQueryReplyColors) => {
    calls.push([environmentId, colors])
  })
  return { calls, call, push: createRemoteRuntimeTerminalColorPush(call) }
}

describe("pushing this client's terminal colours to paired hosts", () => {
  it('tells a host its colours when it connects, and again after it reconnects', () => {
    const { calls, push } = harness()
    push.setColors(DARK)
    expect(calls).toEqual([])

    push.observeStatusSnapshot(snapshot('env-a'))
    push.observeStatusSnapshot(snapshot('env-a', { sequence: 2 }))
    push.observeStatusSnapshot(snapshot('env-a', { transport: 'disconnected' }))
    push.observeStatusSnapshot(snapshot('env-a'))
    // A restarted host lost what it was told.
    push.observeStatusSnapshot(snapshot('env-a', { runtimeId: 'restarted' }))

    expect(calls).toEqual([
      ['env-a', DARK],
      ['env-a', DARK],
      ['env-a', DARK]
    ])
  })

  it('pushes a colour change to every connected host, and nothing for an unchanged one', () => {
    const { calls, push } = harness()
    push.observeStatusSnapshot(snapshot('env-a'))
    push.observeStatusSnapshot(snapshot('env-b'))
    push.observeStatusSnapshot(snapshot('env-c', { verification: 'unavailable' }))

    push.setColors(DARK)
    push.setColors({ ...DARK })
    push.setColors(LIGHT)

    expect(calls).toEqual([
      ['env-a', DARK],
      ['env-b', DARK],
      ['env-a', LIGHT],
      ['env-b', LIGHT]
    ])
  })

  it('re-pushes unchanged colours on focus, since another client may have pushed since', () => {
    const { calls, push } = harness()
    push.setColors(DARK)
    push.observeStatusSnapshot(snapshot('env-a'))

    push.pushToAllHosts()

    expect(calls).toEqual([
      ['env-a', DARK],
      ['env-a', DARK]
    ])
  })

  it('stops asking a host that predates the method until it reconnects', async () => {
    const { calls, call, push } = harness()
    call.mockRejectedValueOnce(methodNotFound())
    push.setColors(DARK)
    push.observeStatusSnapshot(snapshot('env-old'))
    await Promise.resolve()

    push.pushToAllHosts()
    push.setColors(LIGHT)
    expect(calls).toEqual([])

    push.observeStatusSnapshot(snapshot('env-old', { runtimeId: 'updated' }))
    expect(calls).toEqual([['env-old', LIGHT]])
  })

  it('keeps pushing after a transient failure', async () => {
    const { calls, call, push } = harness()
    call.mockRejectedValueOnce(new Error('socket closed'))
    push.setColors(DARK)
    push.observeStatusSnapshot(snapshot('env-a'))
    await Promise.resolve()

    push.pushToAllHosts()

    expect(calls).toEqual([['env-a', DARK]])
  })
})
