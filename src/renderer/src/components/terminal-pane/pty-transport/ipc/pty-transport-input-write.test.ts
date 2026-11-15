import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../../../../../shared/terminal/input/terminal-input'
import '../../../../../../shared/clipboard/clipboard-text'
import {
  createDeferred,
  flushAsyncTicks
} from '../../pty-connection/test-fixtures/pty-connection-test-async'
import type { PtyPreconnectInputEntry } from '../input/pty-preconnect-input-buffer'
import {
  installIpcPtyWindow,
  restorePtySpecWindow,
  type PtyExitPayload
} from './pty-transport-test-harness'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onExit: ((payload: PtyExitPayload) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    onExit = null
    installIpcPtyWindow(originalWindow, {
      exit: (callback) => {
        onExit = callback
      }
    })
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  it('settles a predecessor accepted write while its successor replays the captured bytes', async () => {
    const spawn = createDeferred<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(spawn.promise as never)
    const delivered: string[] = []
    vi.mocked(window.api.pty.writeAccepted).mockImplementation(async (_id, data) => {
      delivered.push(data)
      return true
    })
    const captured: PtyPreconnectInputEntry[] = []
    const { createIpcPtyTransport } = await import('./pty-transport')
    const predecessor = createIpcPtyTransport({
      bufferInputUntilConnect: true,
      onPreconnectInput: (input) => captured.push(input)
    })

    const predecessorAccepted = predecessor.sendInputAccepted?.('\x03', 'driving')
    expect(captured).toEqual([{ data: '\x03', kind: 'accepted', inputKind: 'driving' }])

    const successor = createIpcPtyTransport({ preconnectInput: captured })
    const connecting = successor.connect({ url: '', callbacks: {} })
    await predecessor.destroy?.()

    await expect(predecessorAccepted).resolves.toBe(false)
    spawn.resolve({ id: 'pty-1' })
    await connecting
    await flushAsyncTicks()

    expect(delivered).toEqual(['\x03'])
  })

  it('fences stale accepted chunks when natural exit reuses the same pty id', async () => {
    const acceptedWrite = createDeferred<boolean>()
    vi.mocked(window.api.pty.writeAccepted).mockReturnValueOnce(acceptedWrite.promise)
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({})
    const chunk = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)
    await transport.connect({ url: '', callbacks: {} })

    const accepted = transport.sendInputAccepted?.(`${chunk}stale-tail`, 'driving')
    await flushAsyncTicks()
    expect(window.api.pty.writeAccepted).toHaveBeenCalledExactlyOnceWith('pty-1', chunk, 'driving')

    onExit?.({ id: 'pty-1', code: 0 })
    transport.attach({ existingPtyId: 'pty-1', callbacks: {} })
    expect(transport.sendInput('fresh', 'driving')).toBe(true)

    await expect(accepted).resolves.toBe(false)
    await flushAsyncTicks()
    expect(window.api.pty.write).toHaveBeenCalledExactlyOnceWith('pty-1', 'fresh', 'driving')

    acceptedWrite.resolve(true)
    await flushAsyncTicks()

    expect(window.api.pty.writeAccepted).toHaveBeenCalledExactlyOnceWith('pty-1', chunk, 'driving')
    await expect(accepted).resolves.toBe(false)
  })
})
