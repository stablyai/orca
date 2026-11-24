import { describe, expect, it } from 'vitest'
import { RelayRpcStreams, type RelayStreamFrame } from './relay-rpc-streams'

function streams() {
  const sent: RelayStreamFrame<Record<string, unknown>>[] = []
  let next = 0
  const core = new RelayRpcStreams({
    nextId: () => `r${++next}`,
    sendFrame: (frame) => {
      sent.push(frame)
      return true
    },
    waitForConnected: () => Promise.resolve()
  })
  return { core, sent }
}

const frame = (id: string, result: unknown) => ({
  id,
  ok: true as const,
  result,
  streaming: true as const
})

describe('RelayRpcStreams', () => {
  it('routes frames by the request that opened each stream and releases only its own', async () => {
    const { core, sent } = streams()
    const a: unknown[] = []
    const b: unknown[] = []
    const first = core.subscribe('agentSession.subscribe', { sessionId: 's1' }, (r) => a.push(r))
    core.subscribe('agentSession.subscribe', { sessionId: 's1' }, (r) => b.push(r))
    await Promise.resolve()
    expect(core.handleResponse(frame('r1', { type: 'snapshot', n: 1 }))).toBe(true)
    expect(core.handleResponse(frame('r2', { type: 'event', n: 2 }))).toBe(true)
    expect(a).toEqual([{ type: 'snapshot', n: 1 }])
    expect(b).toEqual([{ type: 'event', n: 2 }])

    first.release()
    expect(sent.at(-1)).toEqual({
      id: 'r3',
      method: 'agentSession.unsubscribe',
      params: { sessionId: 's1', subscriptionId: 'r1' },
      envelope: undefined
    })
    // A released stream's late frame is not another request's reply, and reaches no one.
    expect(core.handleResponse(frame('r1', { type: 'event' }))).toBe(false)
    expect(a).toHaveLength(1)
  })

  it('ends every stream with an error frame when the link closes', async () => {
    const { core } = streams()
    const seen: unknown[] = []
    core.subscribe('agentSession.subscribeStatus', {}, (r) => seen.push(r))
    await Promise.resolve()
    core.failAll('relay closed')
    expect(seen).toEqual([{ type: 'error', message: 'relay closed', error: undefined }])
    expect(core.handleResponse(frame('r1', { type: 'event' }))).toBe(false)
  })
})
