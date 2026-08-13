// Why: a sidecar-flagged chunk must reach raw-byte watchers and NOTHING else —
// the view already restores from main's model snapshot, and letting a mounted
// xterm parse it would put a second DA1/OSC reply on the shell's stdin.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routeDispatchedPtyData } from './pty-data-delivery-routing'
import { ptyDataHandlers, ptyDataSidecars } from './pty-shutdown-data-suspension'
import { drainPreHandlerPtyData, clearPreHandlerPtyState } from './pty-pre-handler-buffer'

const PTY_ID = 'pty-sidecar-only'
const originalWindow = (globalThis as { window?: typeof window }).window

describe('routeDispatchedPtyData', () => {
  beforeEach(() => {
    ;(globalThis as { window: unknown }).window = {
      api: { pty: { ackData: vi.fn() } }
    }
  })

  afterEach(() => {
    ptyDataHandlers.delete(PTY_ID)
    ptyDataSidecars.delete(PTY_ID)
    clearPreHandlerPtyState(PTY_ID)
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: unknown }).window
    }
  })

  it('feeds both the primary handler and sidecars for ordinary chunks', () => {
    const primary = vi.fn()
    const sidecar = vi.fn()
    ptyDataHandlers.set(PTY_ID, primary)
    ptyDataSidecars.set(PTY_ID, new Set([sidecar]))

    routeDispatchedPtyData({ id: PTY_ID, data: 'hello' })

    expect(primary).toHaveBeenCalledWith('hello', undefined)
    expect(sidecar).toHaveBeenCalledWith('hello')
  })

  it('feeds only sidecars when main flags the chunk sidecar-only', () => {
    const primary = vi.fn()
    const sidecar = vi.fn()
    ptyDataHandlers.set(PTY_ID, primary)
    ptyDataSidecars.set(PTY_ID, new Set([sidecar]))

    routeDispatchedPtyData({ id: PTY_ID, data: '\x1b[0c', sidecarOnly: true })

    expect(primary).not.toHaveBeenCalled()
    expect(sidecar).toHaveBeenCalledWith('\x1b[0c')
  })

  it('does not stash a sidecar-only chunk for a pane that mounts later', () => {
    const sidecar = vi.fn()
    ptyDataSidecars.set(PTY_ID, new Set([sidecar]))

    routeDispatchedPtyData({ id: PTY_ID, data: '\x1b[0c', sidecarOnly: true })

    const lateHandler = vi.fn()
    drainPreHandlerPtyData(PTY_ID, lateHandler)
    expect(lateHandler).not.toHaveBeenCalled()
  })
})
