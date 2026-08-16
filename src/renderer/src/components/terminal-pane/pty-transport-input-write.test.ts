import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES
} from '../../../../shared/terminal-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'
import { PTY_INPUT_WRITE_QUEUE_MAX_PENDING_REPLIES } from './pty-input-write-queue'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onWriteUnavailable: ((payload: { id: string }) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    onWriteUnavailable = null
    installIpcPtyWindow(originalWindow, {
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
