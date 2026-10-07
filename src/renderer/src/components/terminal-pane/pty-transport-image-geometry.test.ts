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

it('supplies the calibration at local spawn and leaves SSH activation to its host', async () => {
  const { createIpcPtyTransport } = await import('./pty-transport')
  const local = createIpcPtyTransport({})
  const ssh = createIpcPtyTransport({ connectionId: 'ssh-1' })
  const terminalImageCellSize = { width: 9.025, height: 18 }
  try {
    await local.connect({ url: '', terminalImageCellSize, callbacks: {} })
    expect(window.api.pty.spawn).toHaveBeenLastCalledWith(
      expect.objectContaining({ terminalImageCellSize })
    )
    await ssh.connect({ url: '', terminalImageCellSize, callbacks: {} })
    const request = vi.mocked(window.api.pty.spawn).mock.calls.at(-1)?.[0]
    expect(request).not.toHaveProperty('terminalImageCellSize')
  } finally {
    local.disconnect()
    ssh.disconnect()
  }
})
