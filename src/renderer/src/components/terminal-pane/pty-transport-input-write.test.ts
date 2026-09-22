import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES
} from '../../../../shared/terminal-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'
import { PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES } from './pty-input-write-queue'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  PTY_PRECONNECT_INPUT_MAX_CODE_UNITS,
  PTY_PRECONNECT_INPUT_MAX_ENTRIES,
  type PtyPreconnectInputEntry
} from './pty-preconnect-input-buffer'
import {
  installIpcPtyWindow,
  restorePtySpecWindow,
  type PtyExitPayload
} from './pty-transport-test-harness'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onWriteUnavailable: ((payload: { id: string }) => void) | null = null
  let onExit: ((payload: PtyExitPayload) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    onWriteUnavailable = null
    onExit = null
    installIpcPtyWindow(originalWindow, {
      exit: (callback) => {
        onExit = callback
      },
      writeUnavailable: (callback) => {
        onWriteUnavailable = callback
      }
    })
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  it('routes a rejected daemon write to the owning transport recovery callback', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const recovery = vi.fn()
    const transport = createIpcPtyTransport({})
    await transport.connect({ url: '', callbacks: { onWriteUnavailable: recovery } })

    onWriteUnavailable?.({ id: 'pty-1' })

    expect(recovery).toHaveBeenCalledOnce()
    transport.disconnect()
  })

  it('routes a thrown renderer write to the owning transport recovery callback', async () => {
    const failure = new Error('ipc write failed')
    vi.mocked(window.api.pty.write).mockImplementation(() => {
      throw failure
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const { createIpcPtyTransport } = await import('./pty-transport')
      const recovery = vi.fn()
      const transport = createIpcPtyTransport({})
      await transport.connect({ url: '', callbacks: { onWriteUnavailable: recovery } })

      expect(transport.sendInput('input')).toBe(true)
      expect(transport.sendInput('later-input')).toBe(false)

      expect(recovery).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledWith('[pty-input-write-queue] drain failed:', failure)
    } finally {
      warn.mockRestore()
    }
  })

  it('uses acknowledged writes only for local IPC PTYs', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const localTransport = createIpcPtyTransport({})

    await localTransport.connect({ url: '', callbacks: {} })
    await expect(localTransport.sendInputAccepted?.('\x03')).resolves.toBe(true)
    expect(window.api.pty.writeAccepted).toHaveBeenCalledWith('pty-1', '\x03')

    const sshTransport = createIpcPtyTransport({ connectionId: 'ssh-1' })
    await sshTransport.connect({ url: '', callbacks: {} })
    expect(sshTransport.sendInputAccepted).toBeUndefined()
  })

  it('flushes ordinary, accepted, and immediate split input in byte order', async () => {
    const spawn = createDeferred<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(spawn.promise as never)
    const delivered: string[] = []
    vi.mocked(window.api.pty.write).mockImplementation((_id, data) => {
      delivered.push(data)
    })
    vi.mocked(window.api.pty.writeAccepted).mockImplementation(async (_id, data) => {
      delivered.push(data)
      return true
    })
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })

    const connecting = transport.connect({ url: '', callbacks: {} })
    expect(transport.sendInput('first-')).toBe(true)
    const accepted = transport.sendInputAccepted?.('second-')
    expect(transport.sendInputImmediate('third')).toBe(true)
    expect(window.api.pty.write).not.toHaveBeenCalled()
    expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()

    spawn.resolve({ id: 'pty-1' })
    await connecting
    await expect(accepted).resolves.toBe(true)
    await flushAsyncTicks()

    expect(delivered).toEqual(['first-', 'second-', 'third'])
  })

  it('flushes remount-handoff input before newly typed input without recapturing the seed', async () => {
    const spawn = createDeferred<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(spawn.promise as never)
    const delivered: string[] = []
    vi.mocked(window.api.pty.write).mockImplementation((_id, data) => {
      delivered.push(data)
    })
    vi.mocked(window.api.pty.writeAccepted).mockImplementation(async (_id, data) => {
      delivered.push(data)
      return true
    })
    const onPreconnectInput = vi.fn()
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({
      bufferInputUntilConnect: true,
      preconnectInput: [
        { data: 'before-remount-', kind: 'ordinary' },
        { data: '\x1b[0n', kind: 'immediate' },
        { data: '\x03', kind: 'accepted' }
      ],
      onPreconnectInput
    })

    const connecting = transport.connect({ url: '', callbacks: {} })
    expect(transport.sendInput('new-ordinary-')).toBe(true)
    expect(transport.sendInputImmediate('new-immediate-')).toBe(true)
    const accepted = transport.sendInputAccepted?.('new-accepted')
    expect(onPreconnectInput.mock.calls).toEqual([
      [{ data: 'new-ordinary-', kind: 'ordinary' }],
      [{ data: 'new-immediate-', kind: 'immediate' }],
      [{ data: 'new-accepted', kind: 'accepted' }]
    ])

    spawn.resolve({ id: 'pty-1' })
    await connecting
    await expect(accepted).resolves.toBe(true)
    await flushAsyncTicks()

    expect(delivered).toEqual([
      'before-remount-',
      '\x1b[0n',
      '\x03',
      'new-ordinary-',
      'new-immediate-',
      'new-accepted'
    ])
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

    const predecessorAccepted = predecessor.sendInputAccepted?.('\x03')
    expect(captured).toEqual([{ data: '\x03', kind: 'accepted' }])

    const successor = createIpcPtyTransport({ preconnectInput: captured })
    const connecting = successor.connect({ url: '', callbacks: {} })
    await predecessor.destroy?.()

    await expect(predecessorAccepted).resolves.toBe(false)
    spawn.resolve({ id: 'pty-1' })
    await connecting
    await flushAsyncTicks()

    expect(delivered).toEqual(['\x03'])
  })

  it('contains capture callback failures without rejecting retained input', async () => {
    const onPreconnectInput = vi.fn(() => {
      throw new Error('capture failed')
    })
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({
      bufferInputUntilConnect: true,
      onPreconnectInput
    })

    expect(transport.sendInput('ordinary')).toBe(true)
    expect(transport.sendInputImmediate('immediate')).toBe(true)
    const accepted = transport.sendInputAccepted?.('accepted')
    expect(onPreconnectInput).toHaveBeenCalledTimes(3)

    await transport.connect({ url: '', callbacks: {} })

    await expect(accepted).resolves.toBe(true)
    expect(window.api.pty.write).toHaveBeenCalledWith('pty-1', 'ordinary')
    expect(window.api.pty.write).toHaveBeenCalledWith('pty-1', 'immediate')
    expect(window.api.pty.writeAccepted).toHaveBeenCalledWith('pty-1', 'accepted')
  })

  it('keeps live acknowledged input ahead of later ordinary and immediate writes', async () => {
    vi.useFakeTimers()
    const acceptedWrite = createDeferred<boolean>()
    const delivered: string[] = []
    vi.mocked(window.api.pty.write).mockImplementation((_id, data) => {
      delivered.push(`ordinary:${data}`)
    })
    vi.mocked(window.api.pty.writeAccepted).mockImplementation(async (_id, data) => {
      delivered.push(`accepted:${data}`)
      return acceptedWrite.promise
    })

    try {
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({})
      await transport.connect({ url: '', callbacks: {} })

      expect(transport.sendInput('first')).toBe(true)
      const accepted = transport.sendInputAccepted?.('second')
      expect(transport.sendInput('third')).toBe(true)
      expect(transport.sendInputImmediate('fourth')).toBe(true)
      await flushAsyncTicks()

      expect(delivered).toEqual(['ordinary:first', 'accepted:second'])

      acceptedWrite.resolve(true)
      await vi.runAllTimersAsync()
      await expect(accepted).resolves.toBe(true)

      expect(delivered).toEqual([
        'ordinary:first',
        'accepted:second',
        'ordinary:third',
        'ordinary:fourth'
      ])
    } finally {
      vi.useRealTimers()
    }
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
      expect(transport.sendInput(slowInput)).toBe(true)
      await connecting

      const accepted = transport.sendInputAccepted?.('accepted')
      expect(transport.sendInput('later')).toBe(true)
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

  it('reports a resolved split cwd through local recovery metadata', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const options = { cwd: '/fallback', bufferInputUntilConnect: true }
    const transport = createIpcPtyTransport(options)

    options.cwd = '/resolved/source-cwd'

    expect(transport.getLocalSessionMetadata?.()).toEqual({ cwd: '/resolved/source-cwd' })
  })

  it('settles and drops preconnect input when the split transport is destroyed', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })

    expect(transport.sendInput('ordinary')).toBe(true)
    const accepted = transport.sendInputAccepted?.('accepted')
    await transport.destroy?.()

    await expect(accepted).resolves.toBe(false)
    expect(transport.sendInput('after-destroy')).toBe(false)
    expect(transport.sendInputImmediate('after-destroy')).toBe(false)
    await expect(transport.sendInputAccepted?.('after-destroy')).resolves.toBe(false)
    expect(window.api.pty.write).not.toHaveBeenCalled()
    expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()
  })

  it.each(['disconnect', 'destroy', 'exit'] as const)(
    'cancels an in-flight preconnect accepted write on %s',
    async (teardown) => {
      const spawn = createDeferred<{ id: string }>()
      const acceptedWrite = createDeferred<boolean>()
      vi.mocked(window.api.pty.spawn).mockReturnValue(spawn.promise as never)
      vi.mocked(window.api.pty.writeAccepted).mockReturnValue(acceptedWrite.promise)
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })

      const connecting = transport.connect({ url: '', callbacks: {} })
      const accepted = transport.sendInputAccepted?.('first')
      expect(transport.sendInput('later')).toBe(true)
      spawn.resolve({ id: 'pty-1' })
      await flushAsyncTicks()
      expect(window.api.pty.writeAccepted).toHaveBeenCalledWith('pty-1', 'first')

      if (teardown === 'disconnect') {
        transport.disconnect()
      } else if (teardown === 'destroy') {
        transport.destroy?.()
      } else {
        onExit?.({ id: 'pty-1', code: 0 })
      }

      await expect(accepted).resolves.toBe(false)
      await expect(connecting).resolves.toBe('pty-1')
      expect(window.api.pty.write).not.toHaveBeenCalled()
      expect(transport.sendInput('after-teardown')).toBe(false)

      acceptedWrite.resolve(true)
      await flushAsyncTicks()

      expect(window.api.pty.write).not.toHaveBeenCalled()
      await expect(accepted).resolves.toBe(false)
    }
  )

  it.each(['disconnect', 'detach', 'exit'] as const)(
    'cancels an in-flight live accepted write on %s',
    async (teardown) => {
      const acceptedWrite = createDeferred<boolean>()
      vi.mocked(window.api.pty.writeAccepted).mockReturnValue(acceptedWrite.promise)
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({})
      await transport.connect({ url: '', callbacks: {} })

      const accepted = transport.sendInputAccepted?.('first')
      expect(transport.sendInput('later')).toBe(true)
      await flushAsyncTicks()
      expect(window.api.pty.writeAccepted).toHaveBeenCalledWith('pty-1', 'first')

      if (teardown === 'disconnect') {
        transport.disconnect()
      } else if (teardown === 'detach') {
        transport.detach?.()
      } else {
        onExit?.({ id: 'pty-1', code: 0 })
      }

      await expect(accepted).resolves.toBe(false)
      expect(window.api.pty.write).not.toHaveBeenCalled()
      expect(transport.sendInput('after-teardown')).toBe(false)

      acceptedWrite.resolve(true)
      await flushAsyncTicks()

      expect(window.api.pty.write).not.toHaveBeenCalled()
      await expect(accepted).resolves.toBe(false)
    }
  )

  it.each(['disconnect', 'detach'] as const)(
    'retires a late fresh spawn after %s invalidates its connect',
    async (teardown) => {
      const spawn = createDeferred<{ id: string }>()
      vi.mocked(window.api.pty.spawn).mockReturnValue(spawn.promise as never)
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })
      const onConnect = vi.fn()

      const connecting = transport.connect({ url: '', callbacks: { onConnect } })
      const accepted = transport.sendInputAccepted?.('pending')
      if (teardown === 'disconnect') {
        transport.disconnect()
      } else {
        transport.detach?.()
      }

      spawn.resolve({ id: 'pty-late' })

      await expect(connecting).resolves.toBeUndefined()
      await expect(accepted).resolves.toBe(false)
      expect(window.api.pty.kill).toHaveBeenCalledExactlyOnceWith('pty-late')
      expect(onConnect).not.toHaveBeenCalled()
      expect(transport.isConnected()).toBe(false)
      expect(transport.getPtyId()).toBeNull()
    }
  )

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

  it.each(['disconnect', 'detach'] as const)(
    'drops a late spawn error after %s invalidates its connect',
    async (teardown) => {
      const spawn = createDeferred<{ id: string }>()
      vi.mocked(window.api.pty.spawn).mockReturnValue(spawn.promise as never)
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })
      const staleOnError = vi.fn()
      const currentOnError = vi.fn()

      const connecting = transport.connect({ url: '', callbacks: { onError: staleOnError } })
      if (teardown === 'disconnect') {
        transport.disconnect()
      } else {
        transport.detach?.()
      }
      transport.attach({ existingPtyId: 'pty-current', callbacks: { onError: currentOnError } })

      spawn.reject(new Error('late spawn failed'))

      await expect(connecting).resolves.toBeUndefined()
      expect(staleOnError).not.toHaveBeenCalled()
      expect(currentOnError).not.toHaveBeenCalled()
      expect(transport.getPtyId()).toBe('pty-current')
    }
  )

  it.each(['disconnect', 'detach'] as const)(
    'does not surface a rejected spawn after %s invalidates its connect',
    async (teardown) => {
      const spawn = createDeferred<{ id: string }>()
      vi.mocked(window.api.pty.spawn).mockReturnValue(spawn.promise as never)
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })
      const onError = vi.fn()

      const connecting = transport.connect({ url: '', callbacks: { onError } })
      if (teardown === 'disconnect') {
        transport.disconnect()
      } else {
        transport.detach?.()
      }

      spawn.reject(new Error('late spawn failed'))

      await expect(connecting).resolves.toBeUndefined()
      expect(onError).not.toHaveBeenCalled()
      expect(transport.isConnected()).toBe(false)
      expect(transport.getPtyId()).toBeNull()
    }
  )

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
      await import('./pty-pre-handler-buffer')
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

      expect(transport.sendInput(`${chunk}${chunk}`)).toBe(true)
      expect(window.api.pty.write).toHaveBeenCalledExactlyOnceWith('pty-1', chunk)

      onExit?.({ id: 'pty-1', code: 0 })
      transport.attach({ existingPtyId: 'pty-1', callbacks: {} })
      expect(transport.sendInput('fresh')).toBe(true)

      await vi.runAllTimersAsync()

      expect(vi.mocked(window.api.pty.write).mock.calls).toEqual([
        ['pty-1', chunk],
        ['pty-1', 'fresh']
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

    const accepted = transport.sendInputAccepted?.(`${chunk}stale-tail`)
    await flushAsyncTicks()
    expect(window.api.pty.writeAccepted).toHaveBeenCalledExactlyOnceWith('pty-1', chunk)

    onExit?.({ id: 'pty-1', code: 0 })
    transport.attach({ existingPtyId: 'pty-1', callbacks: {} })
    expect(transport.sendInput('fresh')).toBe(true)

    await expect(accepted).resolves.toBe(false)
    await flushAsyncTicks()
    expect(window.api.pty.write).toHaveBeenCalledExactlyOnceWith('pty-1', 'fresh')

    acceptedWrite.resolve(true)
    await flushAsyncTicks()

    expect(window.api.pty.writeAccepted).toHaveBeenCalledExactlyOnceWith('pty-1', chunk)
    await expect(accepted).resolves.toBe(false)
  })

  it('settles buffered input once and does not re-arm after disconnect', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })

    expect(transport.sendInputImmediate('immediate')).toBe(true)
    const accepted = transport.sendInputAccepted?.('accepted')
    transport.disconnect()

    await expect(accepted).resolves.toBe(false)
    expect(transport.sendInput('after-disconnect')).toBe(false)
    expect(transport.sendInputImmediate('after-disconnect')).toBe(false)
    await expect(transport.sendInputAccepted?.('after-disconnect')).resolves.toBe(false)
    expect(window.api.pty.write).not.toHaveBeenCalled()
    expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()
  })

  it('clears preconnect input when attach observes a buffered exit', async () => {
    const ptyId = 'pty-exited-before-attach-with-input'
    const { bufferPreHandlerPtyExit, clearPreHandlerPtyState } =
      await import('./pty-pre-handler-buffer')
    bufferPreHandlerPtyExit(ptyId, 0)
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })
    const accepted = transport.sendInputAccepted?.('input')

    transport.attach({ existingPtyId: ptyId, callbacks: {} })

    await expect(accepted).resolves.toBe(false)
    expect(transport.isConnected()).toBe(false)
    expect(transport.sendInput('after-exit')).toBe(false)
    clearPreHandlerPtyState(ptyId)
  })

  it('clears preconnect input when attach throws before binding', async () => {
    vi.mocked(window.api.pty.onData).mockImplementationOnce(() => {
      throw new Error('dispatcher attach failed')
    })
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })
    const accepted = transport.sendInputAccepted?.('input')

    expect(() => transport.attach({ existingPtyId: 'pty-attach-failure', callbacks: {} })).toThrow(
      'dispatcher attach failed'
    )

    await expect(accepted).resolves.toBe(false)
    expect(transport.isConnected()).toBe(false)
    expect(transport.sendInput('after-failure')).toBe(false)
  })

  it('settles and drops preconnect input when the split spawn fails', async () => {
    vi.mocked(window.api.pty.spawn).mockRejectedValue(new Error('spawn failed'))
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })
    const onError = vi.fn()

    expect(transport.sendInput('ordinary')).toBe(true)
    const accepted = transport.sendInputAccepted?.('accepted')
    await transport.connect({ url: '', callbacks: { onError } })

    await expect(accepted).resolves.toBe(false)
    expect(transport.sendInput('after-failure')).toBe(false)
    expect(transport.sendInputImmediate('after-failure')).toBe(false)
    await expect(transport.sendInputAccepted?.('after-failure')).resolves.toBe(false)
    expect(onError).toHaveBeenCalledWith('spawn failed')
    expect(window.api.pty.write).not.toHaveBeenCalled()
    expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()
  })

  it('drops later preconnect input when an acknowledged write fails', async () => {
    const spawn = createDeferred<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(spawn.promise as never)
    vi.mocked(window.api.pty.writeAccepted).mockRejectedValue(new Error('write failed'))
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })

    const connecting = transport.connect({ url: '', callbacks: {} })
    expect(transport.sendInput('first')).toBe(true)
    const accepted = transport.sendInputAccepted?.('second')
    expect(transport.sendInput('third')).toBe(true)

    spawn.resolve({ id: 'pty-1' })
    await connecting

    await expect(accepted).resolves.toBe(false)
    expect(window.api.pty.write).toHaveBeenCalledOnce()
    expect(window.api.pty.write).toHaveBeenCalledWith('pty-1', 'first')
  })

  it('drops acknowledged preconnect input when an earlier ordinary write fails', async () => {
    const failure = new Error('ordinary write failed')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(window.api.pty.write).mockImplementationOnce(() => {
      throw failure
    })
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })

    try {
      expect(transport.sendInput('first')).toBe(true)
      const accepted = transport.sendInputAccepted?.('second')
      await transport.connect({ url: '', callbacks: {} })

      await expect(accepted).resolves.toBe(false)
      expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith('[pty-input-write-queue] drain failed:', failure)
    } finally {
      warn.mockRestore()
    }
  })

  it('bounds input retained before a split connects', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })

    for (let index = 0; index < PTY_PRECONNECT_INPUT_MAX_ENTRIES; index += 1) {
      expect(transport.sendInput('x')).toBe(true)
    }
    expect(transport.sendInput('overflow')).toBe(false)

    const oversized = createIpcPtyTransport({ bufferInputUntilConnect: true })
    expect(oversized.sendInput('x'.repeat(PTY_PRECONNECT_INPUT_MAX_CODE_UNITS + 1))).toBe(false)
    await transport.destroy?.()
    await oversized.destroy?.()
  })

  it('chunks large local IPC terminal input before renderer-to-main writes', async () => {
    vi.useFakeTimers()
    try {
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({})
      const chunk = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)

      await transport.connect({ url: '', callbacks: {} })

      expect(transport.sendInput(`${chunk}tail`)).toBe(true)
      expect(window.api.pty.write).toHaveBeenCalledTimes(1)
      expect(window.api.pty.write).toHaveBeenNthCalledWith(1, 'pty-1', chunk)

      await vi.runOnlyPendingTimersAsync()

      expect(window.api.pty.write).toHaveBeenCalledTimes(2)
      expect(window.api.pty.write).toHaveBeenNthCalledWith(2, 'pty-1', 'tail')
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds immediate cooked replies without shedding ordinary-path lookalikes', async () => {
    vi.useFakeTimers()
    try {
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({})
      const first = '\x1b[?10000;1n'
      const ordinary = '\x1b]10;user-ordinary-marker\x1b\\'
      const replies = Array.from({ length: 10_000 }, (_, index) => `\x1b[?${index};1n`)

      await transport.connect({ url: '', callbacks: {} })
      expect(transport.sendInputImmediate(first)).toBe(true)
      expect(transport.sendInput(ordinary)).toBe(true)
      for (const reply of replies) {
        expect(transport.sendInputImmediate(reply)).toBe(true)
      }

      await vi.runAllTimersAsync()

      expect(vi.mocked(window.api.pty.write).mock.calls).toEqual([
        ['pty-1', first],
        ['pty-1', ordinary],
        ...replies
          .slice(-PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES)
          .map((reply) => ['pty-1', reply])
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('yields while validating accepted large local IPC terminal input before renderer-to-main writes', async () => {
    vi.useFakeTimers()
    try {
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({})
      const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

      await transport.connect({ url: '', callbacks: {} })

      expect(transport.sendInput(text)).toBe(true)
      expect(window.api.pty.write).not.toHaveBeenCalled()

      await vi.runAllTimersAsync()

      expect(
        vi
          .mocked(window.api.pty.write)
          .mock.calls.map(([, chunk]) => chunk)
          .join('')
      ).toBe(text)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects oversized local IPC terminal input before renderer-to-main writes', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({})

    await transport.connect({ url: '', callbacks: {} })

    expect(transport.sendInput('x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1))).toBe(false)
    expect(window.api.pty.write).not.toHaveBeenCalled()
  })

  it('chunks large acknowledged local IPC terminal input before writeAccepted IPC', async () => {
    vi.useFakeTimers()
    try {
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({})
      const chunk = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)

      await transport.connect({ url: '', callbacks: {} })

      const accepted = transport.sendInputAccepted?.(`${chunk}tail`)
      await Promise.resolve()
      expect(window.api.pty.writeAccepted).toHaveBeenCalledTimes(1)
      expect(window.api.pty.writeAccepted).toHaveBeenNthCalledWith(1, 'pty-1', chunk)

      await vi.runOnlyPendingTimersAsync()

      await expect(accepted).resolves.toBe(true)
      expect(window.api.pty.writeAccepted).toHaveBeenCalledTimes(2)
      expect(window.api.pty.writeAccepted).toHaveBeenNthCalledWith(2, 'pty-1', 'tail')
    } finally {
      vi.useRealTimers()
    }
  })

  it('yields while validating accepted large acknowledged local IPC terminal input before writeAccepted IPC', async () => {
    vi.useFakeTimers()
    try {
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({})
      const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

      await transport.connect({ url: '', callbacks: {} })

      const accepted = transport.sendInputAccepted?.(text)
      await Promise.resolve()
      expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()

      await vi.runAllTimersAsync()

      await expect(accepted).resolves.toBe(true)
      expect(
        vi
          .mocked(window.api.pty.writeAccepted)
          .mock.calls.map(([, chunk]) => chunk)
          .join('')
      ).toBe(text)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects oversized acknowledged local IPC terminal input before writeAccepted IPC', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({})

    await transport.connect({ url: '', callbacks: {} })

    await expect(
      transport.sendInputAccepted?.('x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1))
    ).resolves.toBe(false)
    expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()
  })
})
