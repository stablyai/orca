// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readRuntimeJiraImage } from './runtime-jira-image-client'
import { encodeJiraImageFrame } from '../../../shared/jira/jira-image-stream-frame'

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
})
