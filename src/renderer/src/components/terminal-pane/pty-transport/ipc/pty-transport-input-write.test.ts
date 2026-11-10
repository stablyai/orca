import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../../../../../shared/terminal/input/terminal-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../../../shared/clipboard-text'
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

  it('preserves queue order across the preconnect-to-live boundary', async () => {
    vi.useFakeTimers()
    const delivered: { data: string; kind: 'ordinary' | 'accepted' }[] = []
    vi.mocked(window.api.pty.write).mockImplementation((_id, data) => {
      delivered.push({ data, kind: 'ordinary' })
    })
    vi.mocked(window.api.pty.writeAccepted).mockImplementation(async (_id, data) => {
      delivered.push({ data, kind: 'accepted' })
      return true
    })

    try {
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })
      const slowInput = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

      const connecting = transport.connect({ url: '', callbacks: {} })
      expect(transport.sendInput(slowInput, 'driving')).toBe(true)
      await connecting

      const accepted = transport.sendInputAccepted?.('accepted', 'driving')
      expect(transport.sendInput('later', 'driving')).toBe(true)
      expect(transport.sendInputImmediate('reply')).toBe(true)
      expect(delivered).toEqual([])

      await vi.runAllTimersAsync()
      await expect(accepted).resolves.toBe(true)

      const acceptedIndex = delivered.findIndex((entry) => entry.kind === 'accepted')
      expect(acceptedIndex).toBeGreaterThan(0)
      expect(
        delivered
          .slice(0, acceptedIndex)
          .map((entry) => entry.data)
          .join('')
      ).toBe(slowInput)
      expect(delivered.slice(acceptedIndex)).toEqual([
        { data: 'accepted', kind: 'accepted' },
        { data: 'later', kind: 'ordinary' },
        { data: 'reply', kind: 'ordinary' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retire a stale fresh spawn id owned by a newer attach', async () => {
    const spawn = createDeferred<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(spawn.promise as never)
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })

    const connecting = transport.connect({ url: '', callbacks: {} })
    transport.attach({ existingPtyId: 'pty-reused', callbacks: {} })
    spawn.resolve({ id: 'pty-reused' })

    await expect(connecting).resolves.toBeUndefined()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
    expect(transport.isConnected()).toBe(true)
    expect(transport.getPtyId()).toBe('pty-reused')
  })

  it('does not leave stale exit handlers when onPtySpawn tears down synchronously', async () => {
    const onExitCallback = vi.fn()
    const onPtyExit = vi.fn()
    let transport: ReturnType<typeof createIpcPtyTransport> | undefined
    const { createIpcPtyTransport } = await import('./pty-transport')
    transport = createIpcPtyTransport({
      onPtySpawn: () => transport?.disconnect(),
      onPtyExit
    })

    const connecting = transport.connect({
      url: '',
      callbacks: { onExit: onExitCallback }
    })
    await expect(connecting).resolves.toBeUndefined()

    onExit?.({ id: 'pty-1', code: 0 })

    expect(onExitCallback).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBeNull()
  })

  it('does not return a stale exitedBeforeAttach result after its exit callback tears down', async () => {
    const { bufferPreHandlerPtyExit, clearPreHandlerPtyState } =
      await import('../delivery/pty-pre-handler-buffer')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const sessionId = 'pty-buffered-exit-teardown'
    bufferPreHandlerPtyExit(sessionId, 0)
    let transport: ReturnType<typeof createIpcPtyTransport> | undefined
    const onExitCallback = vi.fn(() => transport?.disconnect())
    transport = createIpcPtyTransport({})

    try {
      await expect(
        transport.connect({ url: '', sessionId, callbacks: { onExit: onExitCallback } })
      ).resolves.toBeUndefined()

      onExit?.({ id: sessionId, code: 0 })
      expect(onExitCallback).toHaveBeenCalledOnce()
    } finally {
      clearPreHandlerPtyState(sessionId)
    }
  })

  it('fences stale queued chunks when natural exit reuses the same pty id', async () => {
    vi.useFakeTimers()
    try {
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({})
      const chunk = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)
      await transport.connect({ url: '', callbacks: {} })

      expect(transport.sendInput(`${chunk}${chunk}`, 'driving')).toBe(true)
      expect(window.api.pty.write).toHaveBeenCalledExactlyOnceWith('pty-1', chunk, 'driving')

      onExit?.({ id: 'pty-1', code: 0 })
      transport.attach({ existingPtyId: 'pty-1', callbacks: {} })
      expect(transport.sendInput('fresh', 'driving')).toBe(true)

      await vi.runAllTimersAsync()

      expect(vi.mocked(window.api.pty.write).mock.calls).toEqual([
        ['pty-1', chunk, 'driving'],
        ['pty-1', 'fresh', 'driving']
      ])
    } finally {
      vi.useRealTimers()
    }
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
