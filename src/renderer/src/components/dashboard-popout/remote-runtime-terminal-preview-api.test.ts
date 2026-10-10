import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteRuntimeMultiplexedTerminalCallbacks } from '@/runtime/remote-runtime-terminal-multiplexer'
import type { TerminalPreviewDataPayload } from '../../../../shared/terminal-preview'

type Subscription = {
  environmentId: string
  terminal: string
  clientId: string
  callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
  stream: {
    sendInput: ReturnType<typeof vi.fn>
    claimViewport: ReturnType<typeof vi.fn>
    serializeBufferOutcome: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
}

const harness = vi.hoisted(() => {
  const subscriptions: Subscription[] = []
  return { subscriptions }
})

vi.mock('@/runtime/remote-runtime-terminal-multiplexer', () => ({
  getRemoteRuntimeTerminalMultiplexer: (environmentId: string) => ({
    subscribeTerminal: async (args: {
      terminal: string
      client: { id: string }
      callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
    }) => {
      const stream = {
        sendInput: vi.fn(() => true),
        claimViewport: vi.fn(() => true),
        serializeBufferOutcome: vi.fn(),
        close: vi.fn()
      }
      harness.subscriptions.push({
        environmentId,
        terminal: args.terminal,
        clientId: args.client.id,
        callbacks: args.callbacks,
        stream
      })
      return stream
    }
  })
}))

import { deliverTerminalDataWithDeferredCredit } from '@/lib/pane-manager/terminal-delivery-credit'
import {
  remoteRuntimeTerminalPreviewApi as api,
  resetRemoteRuntimeTerminalPreviewSessionsForTests
} from './remote-runtime-terminal-preview-api'

const PTY = 'remote:env-a@@term-1'

async function openPreview(): Promise<{
  sub: Subscription
  payloads: TerminalPreviewDataPayload[]
}> {
  const payloads: TerminalPreviewDataPayload[] = []
  api.onData((payload) => payloads.push(payload))
  const connecting = api.connect(PTY, { scrollbackRows: 24 })
  await vi.waitFor(() => expect(harness.subscriptions).toHaveLength(1))
  const sub = harness.subscriptions[0]!
  sub.callbacks.onSnapshot('screen', { cols: 90, rows: 30, seq: 10 })
  await expect(connecting).resolves.toEqual({
    snapshot: expect.objectContaining({ data: 'screen', cols: 90, rows: 30, seq: 10 }),
    replay: []
  })
  return { sub, payloads }
}

describe('remoteRuntimeTerminalPreviewApi', () => {
  afterEach(() => {
    resetRemoteRuntimeTerminalPreviewSessionsForTests()
    harness.subscriptions.length = 0
  })

  it('subscribes on the host named by the pty id with a preview-only client', async () => {
    const { sub, payloads } = await openPreview()
    expect(sub.environmentId).toBe('env-a')
    expect(sub.terminal).toBe('term-1')
    expect(sub.clientId).toMatch(/^dashboard-preview:/)

    sub.callbacks.onData('live', { seq: 14 })
    expect(payloads).toEqual([{ type: 'data', ptyId: PTY, data: 'live', bytes: 4 }])
    await expect(api.input(PTY, 'x')).resolves.toBe(true)
    expect(sub.stream.sendInput).toHaveBeenCalledWith('x')
  })

  it('refuses an id without its owning host instead of guessing one', async () => {
    await expect(api.connect('remote:term-1')).resolves.toEqual({ snapshot: null, replay: [] })
    expect(harness.subscriptions).toHaveLength(0)
  })

  it('refreshes on the same stream and replays only output past the snapshot', async () => {
    const { sub, payloads } = await openPreview()
    let answer: (value: unknown) => void = () => {}
    sub.stream.serializeBufferOutcome.mockReturnValue(new Promise((resolve) => (answer = resolve)))

    const refreshing = api.connect(PTY, { scrollbackRows: 24 })
    sub.callbacks.onData('covered', { seq: 20 })
    sub.callbacks.onData('after', { seq: 25 })
    answer({
      availability: { kind: 'snapshot' },
      snapshot: { data: 'fresh', cols: 90, rows: 30, seq: 20 }
    })

    await expect(refreshing).resolves.toEqual({
      snapshot: expect.objectContaining({ data: 'fresh', seq: 20 }),
      replay: [{ data: 'after', mode: 'live' }]
    })
    expect(sub.stream.serializeBufferOutcome).toHaveBeenCalledWith({ scrollbackRows: 24 })
    expect(harness.subscriptions).toHaveLength(1)
    expect(payloads).toEqual([])
  })

  it('drops covered output the host forwards after a requested snapshot and slices a straddler', async () => {
    const { sub, payloads } = await openPreview()
    sub.stream.serializeBufferOutcome.mockResolvedValue({
      availability: { kind: 'snapshot' },
      snapshot: { data: 'fresh', cols: 90, rows: 30, seq: 20 }
    })
    await expect(api.connect(PTY)).resolves.toMatchObject({ replay: [] })

    // A tagged reply is followed by every chunk the host buffered, covered ones included.
    sub.callbacks.onData('old', { seq: 18, rawLength: 3 })
    sub.callbacks.onData('ABCDE', { seq: 23, rawLength: 5 })
    sub.callbacks.onData('next', { seq: 27, rawLength: 4 })
    expect(payloads).toEqual([
      { type: 'data', ptyId: PTY, data: 'CDE', bytes: 3 },
      { type: 'data', ptyId: PTY, data: 'next', bytes: 4 }
    ])
  })

  it('returns transport credit only once the preview has parsed the chunk', async () => {
    const { sub } = await openPreview()
    const credit = vi.fn()
    deliverTerminalDataWithDeferredCredit(credit, () =>
      sub.callbacks.onData('live', { seq: 14, rawLength: 4 })
    )
    expect(credit).not.toHaveBeenCalled()

    await api.ack(PTY, 4)
    expect(credit).toHaveBeenCalledTimes(1)
  })

  it('returns held credit when the preview closes', async () => {
    const { sub } = await openPreview()
    const credit = vi.fn()
    deliverTerminalDataWithDeferredCredit(credit, () => sub.callbacks.onData('live', { seq: 14 }))

    await api.unsubscribe(PTY)
    expect(credit).toHaveBeenCalledTimes(1)
  })

  it('asks for a repaint when the grid changes, not when the same grid is re-announced', async () => {
    const { sub, payloads } = await openPreview()
    await expect(api.fit(PTY, 120, 40)).resolves.toEqual({ cols: 120, rows: 40 })
    expect(sub.stream.claimViewport).toHaveBeenCalledWith(120, 40)

    sub.callbacks.onFitOverrideChanged?.({ mode: 'remote-desktop-fit', cols: 90, rows: 30 })
    expect(payloads).toEqual([])
    sub.callbacks.onFitOverrideChanged?.({ mode: 'remote-desktop-fit', cols: 120, rows: 40 })
    expect(payloads).toEqual([{ type: 'resync', ptyId: PTY }])
  })

  it('reports an ended stream as unavailable on the next connect', async () => {
    const { sub, payloads } = await openPreview()
    sub.callbacks.onEnd?.('exited')
    expect(payloads).toEqual([{ type: 'resync', ptyId: PTY }])

    await expect(api.connect(PTY)).resolves.toEqual({ snapshot: null, replay: [] })
    expect(sub.stream.close).toHaveBeenCalled()
  })

  it('reopens after loss of contact rather than calling the pane gone', async () => {
    const { sub } = await openPreview()
    sub.callbacks.onTransportClose?.({ recoverable: true })

    const reopening = api.connect(PTY)
    await vi.waitFor(() => expect(harness.subscriptions).toHaveLength(2))
    harness.subscriptions[1]!.callbacks.onSnapshot('again', { cols: 90, rows: 30, seq: 3 })
    await expect(reopening).resolves.toMatchObject({ snapshot: { data: 'again' } })
    expect(sub.stream.serializeBufferOutcome).not.toHaveBeenCalled()
  })

  it('closes the host stream on unsubscribe so its viewport claim is released', async () => {
    const { sub } = await openPreview()
    await api.unsubscribe(PTY)
    expect(sub.stream.close).toHaveBeenCalledTimes(1)
    await expect(api.input(PTY, 'x')).resolves.toBe(false)
  })
})
