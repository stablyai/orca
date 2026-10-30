import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteRuntimeMultiplexedTerminalCallbacks } from '@/runtime/remote-runtime-terminal-multiplexer-types'
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
  const state: { subscriptions: Subscription[]; streamWait: Promise<void> | null } = {
    subscriptions,
    streamWait: null
  }
  return state
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
      if (harness.streamWait) {
        await harness.streamWait
      }
      return stream
    }
  })
}))

import { deliverTerminalDataWithDeferredCredit } from '@/lib/pane-manager/terminal-delivery-credit'
import {
  remoteRuntimeTerminalPreviewApi as api,
  bindRemoteRuntimeTerminalPreview,
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
  const sub = harness.subscriptions[0]
  if (!sub) {
    throw new Error('Missing stream')
  }
  sub.callbacks.onSnapshot('screen', { cols: 90, rows: 30, seq: 10 })
  await expect(connecting).resolves.toEqual({
    snapshot: expect.objectContaining({ data: 'screen', cols: 90, rows: 30, seq: 10 }),
    replay: []
  })
  return { sub, payloads }
}

afterEach(() => {
  resetRemoteRuntimeTerminalPreviewSessionsForTests()
  harness.subscriptions.length = 0
  harness.streamWait = null
})

describe('remoteRuntimeTerminalPreviewApi', () => {
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

describe('paired source publication', () => {
  it('retires both contradicted writers before any observer, joins reentry and installs all before notification', async () => {
    const first = bindRemoteRuntimeTerminalPreview(PTY)
    const second = bindRemoteRuntimeTerminalPreview(PTY)
    const opening = first.connect(PTY)
    await vi.waitFor(() => expect(harness.subscriptions).toHaveLength(1))
    const sub = harness.subscriptions[0]
    if (!sub) {
      throw new Error('Missing preview stream')
    }
    sub.callbacks.onSubscribeAcknowledged?.({ ptyId: 'pty', incarnationId: 'i1' })
    sub.callbacks.onSnapshot('screen', { cols: 80, rows: 24 })
    await opening
    sub.stream.serializeBufferOutcome.mockResolvedValue({
      availability: { kind: 'snapshot' },
      snapshot: { data: 'screen', cols: 80, rows: 24 }
    })
    await second.connect(PTY)
    const a = first.getInputSource()
    const b = second.getInputSource()
    if (!a || !b) {
      throw new Error('Missing initial sources')
    }
    sub.callbacks.onTransportClose?.({ recoverable: true })
    const recovery = first.connect(PTY)
    const joined = second.connect(PTY)
    await vi.waitFor(() => expect(harness.subscriptions).toHaveLength(2))
    const recovered = harness.subscriptions[1]
    if (!recovered) {
      throw new Error('Missing recovered stream')
    }
    const third = bindRemoteRuntimeTerminalPreview(PTY)
    const events: string[] = []
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const one = first.observeInputSource({
      beforeChange: () => {
        events.push('before1')
        expect(a.isCurrent()).toBe(false)
        expect(b.sendInput('forbidden-i1', 'driving')).toBe(false)
        void second.connect(PTY)
        void third.connect(PTY)
        expect(third.getInputSource()).toBeNull()
        throw new Error('observer failure')
      },
      afterChange: (source) => {
        if (source !== a) {
          events.push('after1')
          expect(second.getInputSource()?.isCurrent()).toBe(true)
          expect(third.getInputSource()?.isCurrent()).toBe(true)
          expect(source?.sendInput('fresh-i2', 'driving')).toBe(true)
        }
      }
    })
    const two = second.observeInputSource({
      beforeChange: () => {
        events.push('before2')
      },
      afterChange: (source) => {
        if (source !== b) {
          events.push('after2')
        }
      }
    })
    recovered.callbacks.onSubscribeAcknowledged?.({ ptyId: 'pty', incarnationId: 'i2' })
    expect(events).toEqual(['before1', 'before2', 'after1', 'after2'])
    expect(recovered.stream.sendInput.mock.calls).toEqual([['fresh-i2']])
    recovered.callbacks.onSnapshot('new screen', { cols: 80, rows: 24 })
    await Promise.all([recovery, joined])
    expect(warning).toHaveBeenCalledOnce()
    one.dispose()
    two.dispose()
    warning.mockRestore()
    await first.unsubscribe(PTY)
  })

  it('keeps compatible recovery proof, refuses a failed prefix without replay and ends old tokens finally', async () => {
    const binding = bindRemoteRuntimeTerminalPreview(PTY)
    const opening = binding.connect(PTY)
    await vi.waitFor(() => expect(harness.subscriptions).toHaveLength(1))
    const original = harness.subscriptions[0]
    if (!original) {
      throw new Error('Missing original stream')
    }
    original.callbacks.onSubscribeAcknowledged?.({ ptyId: 'pty', incarnationId: 'i1' })
    original.callbacks.onSnapshot('screen', { cols: 80, rows: 24 })
    await opening
    const a = binding.getInputSource()
    if (!a) {
      throw new Error('Missing source')
    }
    original.callbacks.onTransportClose?.({ recoverable: true })
    expect(a.sendInput('refused-prefix', 'driving')).toBe(false)
    const recovering = binding.connect(PTY)
    await vi.waitFor(() => expect(harness.subscriptions).toHaveLength(2))
    const recovered = harness.subscriptions[1]
    if (!recovered) {
      throw new Error('Missing recovery')
    }
    recovered.callbacks.onSubscribeAcknowledged?.({ ptyId: 'pty', incarnationId: 'i1' })
    recovered.callbacks.onSnapshot('again', { cols: 80, rows: 24 })
    await recovering
    expect(binding.getInputSource()).toBe(a)
    expect(a.sendInput('physical-tail', 'driving')).toBe(true)
    expect(recovered.stream.sendInput.mock.calls).toEqual([['physical-tail']])
    const after = vi.fn()
    const observer = binding.observeInputSource({
      beforeChange: () => {
        expect(a.sendInput('ended', 'driving')).toBe(false)
      },
      afterChange: after
    })
    recovered.callbacks.onEnd?.('exited')
    expect(a.isCurrent()).toBe(false)
    expect(binding.getInputSource()).toBeNull()
    expect(recovered.stream.close).toHaveBeenCalledOnce()
    observer.dispose()
    await binding.unsubscribe(PTY)
  })

  it('settles live close to its original writer and never revives the old lifetime', async () => {
    const binding = bindRemoteRuntimeTerminalPreview(PTY)
    const opening = binding.connect(PTY)
    await vi.waitFor(() => expect(harness.subscriptions).toHaveLength(1))
    const sub = harness.subscriptions[0]
    if (!sub) {
      throw new Error('Missing stream')
    }
    sub.callbacks.onSnapshot('screen', { cols: 80, rows: 24 })
    await opening
    const a = binding.getInputSource()
    if (!a) {
      throw new Error('Missing live source')
    }
    const observer = binding.observeInputSource({
      beforeChange: () => {
        expect(a.sendInput('live-A', 'driving')).toBe(true)
      },
      afterChange: () => {}
    })
    await binding.unsubscribe(PTY)
    expect(sub.stream.sendInput.mock.calls).toEqual([['live-A']])
    expect(sub.stream.close).toHaveBeenCalledOnce()
    observer.dispose()
    const reopening = binding.connect(PTY)
    await vi.waitFor(() => expect(harness.subscriptions).toHaveLength(2))
    const next = harness.subscriptions[1]
    if (!next) {
      throw new Error('Missing successor')
    }
    next.callbacks.onSnapshot('new lifetime', { cols: 80, rows: 24 })
    await reopening
    expect(binding.getInputSource()).not.toBe(a)
    expect(a.sendInput('cannot-revive', 'driving')).toBe(false)
    expect(binding.getInputSource()?.sendInput('current-B', 'driving')).toBe(true)
    await binding.unsubscribe(PTY)
  })
})

it('closes a late returned stream after reliable end without reviving the binding', async () => {
  let release = (): void => {}
  harness.streamWait = new Promise<void>((resolve) => {
    release = resolve
  })
  const binding = bindRemoteRuntimeTerminalPreview(PTY)
  const opening = binding.connect(PTY)
  const sub = harness.subscriptions.at(-1)
  if (!sub) {
    throw new Error('missing opening stream')
  }
  sub.callbacks.onSubscribeAcknowledged?.({ ptyId: 'pty', incarnationId: 'i1' })
  const source = binding.getInputSource()
  sub.callbacks.onEnd?.('exited')
  await expect(opening).resolves.toEqual({ snapshot: null, replay: [] })
  release()
  await vi.waitFor(() => expect(sub.stream.close).toHaveBeenCalledOnce())
  expect(source?.isCurrent()).toBe(false)
  expect(binding.getInputSource()).toBeNull()
  await binding.unsubscribe(PTY)
})

it('keeps retired A dead through actual recoveries A to B to A', async () => {
  const binding = bindRemoteRuntimeTerminalPreview(PTY)
  let a: ReturnType<typeof binding.getInputSource> = null
  for (const [index, incarnationId] of ['i1', 'i2', 'i1'].entries()) {
    const opening = binding.connect(PTY)
    await vi.waitFor(() => expect(harness.subscriptions).toHaveLength(index + 1))
    const sub = harness.subscriptions[index]
    if (!sub) {
      throw new Error('missing recovery')
    }
    sub.callbacks.onSubscribeAcknowledged?.({ ptyId: 'pty', incarnationId })
    sub.callbacks.onSnapshot('screen', { cols: 80, rows: 24 })
    await opening
    const current = binding.getInputSource()
    if (index === 0) {
      a = current
    } else {
      expect(current).not.toBe(a)
      expect(a?.sendInput('old-A', 'driving')).toBe(false)
    }
    expect(current?.sendInput(`current-${incarnationId}`, 'driving')).toBe(true)
    expect(sub.stream.sendInput.mock.calls).toEqual([[`current-${incarnationId}`]])
    if (index < 2) {
      sub.callbacks.onTransportClose?.({ recoverable: true })
    }
  }
  await binding.unsubscribe(PTY)
})
