// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readRuntimeJiraImage } from './runtime-jira-image-client'
import { encodeJiraImageFrame } from '../../../shared/jira-image-stream-frame'

type Callbacks = Parameters<typeof window.api.runtimeEnvironments.subscribe>[1]
const subscribe = vi.fn()
const streams: { callbacks: Callbacks; transferId: string; close: ReturnType<typeof vi.fn> }[] = []
const target = { kind: 'environment' as const, environmentId: 'remote' }
const reference = '12345678-1234-4234-8234-123456789012'
function stream(index = 0) {
  const value = streams[index]
  if (!value) {
    throw new Error('Missing image stream')
  }
  return value
}
function emit(result: unknown, index = 0): void {
  stream(index).callbacks.onResponse({
    id: 'image',
    ok: true,
    result,
    _meta: { runtimeId: 'remote' }
  })
}
function send(bytes: Uint8Array, sequence = 0, index = 0): void {
  stream(index).callbacks.onBinary?.(
    encodeJiraImageFrame(stream(index).transferId, sequence, bytes)
  )
}
function read() {
  return readRuntimeJiraImage(target, reference, new AbortController().signal)
}

beforeEach(() => {
  streams.length = 0
  subscribe
    .mockReset()
    .mockImplementation(async (args: { params: unknown }, callbacks: Callbacks) => {
      if (
        !args.params ||
        typeof args.params !== 'object' ||
        !('transferId' in args.params) ||
        typeof args.params.transferId !== 'string'
      ) {
        throw new Error('Missing transfer identity')
      }
      const close = vi.fn()
      streams.push({ callbacks, transferId: args.params.transferId, close })
      return { unsubscribe: close, sendBinary: vi.fn() }
    })
  vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('remote Jira binary images', () => {
  it('assembles only its own ordered image frames and closes the subscription', async () => {
    const image = read()
    emit({ type: 'image', mimeType: 'image/png', byteLength: 3 })
    stream().callbacks.onBinary?.(Uint8Array.from([0x74, 1, 0, 0]))
    stream().callbacks.onBinary?.(
      encodeJiraImageFrame('87654321-4321-4321-8321-210987654321', 0, Uint8Array.of(99))
    )
    send(Uint8Array.from([1, 2]))
    send(Uint8Array.of(3), 1)
    emit({ type: 'end' })
    const blob = await image
    expect(blob.type).toBe('image/png')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3]))
    await Promise.resolve()
    expect(stream().close).toHaveBeenCalledOnce()
  })

  it.each([
    { mimeType: 'image/svg+xml', byteLength: 1 },
    { mimeType: 'image/png', byteLength: 8 * 1024 * 1024 + 1 },
    { mimeType: 'image/png', byteLength: -1 }
  ])('rejects invalid or oversized metadata before retaining bytes: %o', async (header) => {
    const image = read().catch((error) => error)
    emit({ type: 'image', ...header })
    expect(await image).toBeInstanceOf(Error)
    expect(stream().close).toHaveBeenCalledOnce()
  })

  it.each(['before metadata', 'out of order', 'oversized', 'incomplete'] as const)(
    'rejects %s image chunks',
    async (mode) => {
      const image = read().catch((error) => error)
      if (mode !== 'before metadata') {
        emit({ type: 'image', mimeType: 'image/png', byteLength: 1 })
      }
      if (mode === 'incomplete') {
        emit({ type: 'end' })
      } else {
        send(
          mode === 'oversized' ? Uint8Array.from([1, 2]) : Uint8Array.of(1),
          mode === 'out of order' ? 1 : 0
        )
      }
      expect(await image).toBeInstanceOf(Error)
      expect(stream().close).toHaveBeenCalledOnce()
    }
  )

  it('separates simultaneous image transfers on a shared binary carrier', async () => {
    const a = read()
    const b = read()
    emit({ type: 'image', mimeType: 'image/png', byteLength: 1 }, 0)
    emit({ type: 'image', mimeType: 'image/png', byteLength: 1 }, 1)
    for (const [index, byte] of [
      [0, 1],
      [1, 2]
    ]) {
      const frame = encodeJiraImageFrame(stream(index).transferId, 0, Uint8Array.of(byte))
      for (const opened of streams) {
        opened.callbacks.onBinary?.(frame)
      }
    }
    emit({ type: 'end' }, 0)
    emit({ type: 'end' }, 1)
    expect(new Uint8Array(await (await a).arrayBuffer())).toEqual(Uint8Array.of(1))
    expect(new Uint8Array(await (await b).arrayBuffer())).toEqual(Uint8Array.of(2))
  })

  it('cancels before the subscribe handle is returned', async () => {
    let finish: ((value: { unsubscribe: () => void; sendBinary: () => void }) => void) | undefined
    const close = vi.fn()
    subscribe.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const controller = new AbortController()
    const image = readRuntimeJiraImage(target, reference, controller.signal).catch((error) => error)
    controller.abort()
    expect(await image).toBeInstanceOf(Error)
    finish?.({ unsubscribe: close, sendBinary: vi.fn() })
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
  })

  it('ends stalled image downloads after the transfer deadline', async () => {
    vi.useFakeTimers()
    const image = read().catch((error) => error)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await image).toMatchObject({ message: 'Jira image transfer timed out.' })
    expect(stream().close).toHaveBeenCalledOnce()
  })
})
