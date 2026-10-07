import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

const originalWindow = typeof window === 'undefined' ? undefined : window
beforeEach(() => {
  vi.resetModules()
  installIpcPtyWindow(originalWindow, {})
})
afterEach(() => restorePtySpecWindow(originalWindow))

it('carries fractional CSS cell sizes only to the local execution model', async () => {
  const { createIpcPtyTransport } = await import('./pty-transport')
  const local = createIpcPtyTransport({})
  const ssh = createIpcPtyTransport({ connectionId: 'ssh-1' })
  try {
    await local.connect({ url: '', callbacks: {} })
    local.resize(80, 24, { cellW: 9.025, cellH: 18 })
    expect(window.api.pty.resize).toHaveBeenLastCalledWith('pty-1', 80, 24, {
      width: 9.025,
      height: 18
    })
    await ssh.connect({ url: '', callbacks: {} })
    ssh.resize(80, 24, { cellW: 9.025, cellH: 18 })
    expect(window.api.pty.resize).toHaveBeenLastCalledWith('pty-1', 80, 24)
  } finally {
    local.disconnect()
    ssh.disconnect()
  }
})
