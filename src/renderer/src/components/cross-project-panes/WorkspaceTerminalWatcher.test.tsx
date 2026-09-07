// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceTerminalWatcher } from './WorkspaceTerminalWatcher'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings: null }) } }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    open() {}
    write(_data: string, done?: () => void) {
      done?.()
    }
    reset() {}
    resize() {}
    dispose() {}
  }
}))
vi.mock('../dashboard-popout/preview-terminal-box-fit', () => ({
  createPreviewBoxFit: () => ({ schedule: () => {} })
}))
vi.mock('@/runtime/remote-runtime-terminal-multiplexer', () => ({
  getRemoteRuntimeTerminalMultiplexer: vi.fn()
}))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('reports failed resync, retries, clears the error and cancels recovery on detach', async () => {
  let onData: (event: unknown) => void = () => {}
  const snapshot = { snapshot: { cols: 80, rows: 24, data: 'live' }, replay: [] }
  const connect = vi.fn().mockResolvedValue(snapshot)
  const unsubscribe = vi.fn()
  Object.assign(window, {
    api: {
      terminalPreview: {
        connect,
        unsubscribe,
        ack: vi.fn(),
        onData: (callback: typeof onData) => {
          onData = callback
          return vi.fn()
        }
      }
    }
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  const mounted = render(<WorkspaceTerminalWatcher ptyId="pty" viewId="view" />)
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
  connect.mockRejectedValueOnce(new Error('snapshot disconnected'))
  act(() => onData({ type: 'resync', ptyId: 'pty', viewId: 'view' }))
  expect((await screen.findByRole('status')).textContent).toContain('snapshot disconnected')
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 2000 })
  expect(connect).toHaveBeenCalledTimes(3)
  connect.mockResolvedValue({ ...snapshot, resyncRequired: true })
  act(() => onData({ type: 'resync', ptyId: 'pty', viewId: 'view' }))
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(4))
  mounted.unmount()
  await new Promise((resolve) => setTimeout(resolve, 550))
  expect(connect).toHaveBeenCalledTimes(4)
  expect(unsubscribe).toHaveBeenCalledWith('pty', 'view')
})
