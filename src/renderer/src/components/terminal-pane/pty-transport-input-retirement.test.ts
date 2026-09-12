import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'

const originalWindow = (globalThis as { window?: typeof window }).window
beforeEach(() => {
  vi.resetModules()
  installIpcPtyWindow(originalWindow, {})
})
afterEach(() => restorePtySpecWindow(originalWindow))

it.each([undefined, 'ssh-1'])(
  'exposes provider-backed retirement for connection %s',
  async (connectionId) => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const retire = vi.fn().mockResolvedValue(true)
    window.api.pty.retireWriteOperation = retire
    const transport = createIpcPtyTransport({ connectionId })
    await expect(transport.retireInputOperation?.('input')).resolves.toBe(false)
    await transport.connect({ url: '', callbacks: {} })
    await expect(transport.retireInputOperation?.('input')).resolves.toBe(true)
    expect(retire).toHaveBeenCalledWith('pty-1', 'input')
    transport.disconnect()
    await expect(transport.retireInputOperation?.('input')).resolves.toBe(false)
    expect(retire).toHaveBeenCalledOnce()
  }
)

it('treats an older preload without retirement as unsupported', async () => {
  const { createIpcPtyTransport } = await import('./pty-transport')
  window.api.pty.retireWriteOperation = undefined
  const transport = createIpcPtyTransport({})
  await transport.connect({ url: '', callbacks: {} })
  await expect(transport.retireInputOperation?.('input')).resolves.toBe(false)
  transport.disconnect()
})

it('retires a local-style terminal paste only after an acknowledged write', async () => {
  const { createIpcPtyTransport } = await import('./pty-transport')
  let complete!: (accepted: boolean) => void
  vi.mocked(window.api.pty.writeAccepted).mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        complete = resolve
      })
  )
  const retire = vi.fn().mockResolvedValue(true)
  window.api.pty.retireWriteOperation = retire
  const transport = createIpcPtyTransport({})
  await transport.connect({ url: '', callbacks: {} })
  const pending = writeTerminalPastePtyInput(transport, 'data', { operationId: 'input' })
  expect(retire).not.toHaveBeenCalled()
  complete(true)
  await expect(pending).resolves.toBe(true)
  expect(retire).toHaveBeenCalledWith('pty-1', 'input')
  transport.disconnect()
})
