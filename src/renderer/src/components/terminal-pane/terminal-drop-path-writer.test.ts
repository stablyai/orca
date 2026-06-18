import { describe, expect, it, vi } from 'vitest'
import { writeTerminalDropPathsToCapturedTarget } from './terminal-drop-path-writer'

function createTransport(
  sendInput: ReturnType<typeof vi.fn>,
  ptyId = 'pty-1',
  sendInputAccepted?: ReturnType<typeof vi.fn>
) {
  return {
    sendInput,
    ...(sendInputAccepted ? { sendInputAccepted } : {}),
    getPtyId: vi.fn(() => ptyId),
    isConnected: vi.fn(() => true)
  }
}

function createManager() {
  const pane = { id: 1, leafId: 'leaf-1' }
  return {
    pane,
    manager: {
      getActivePane: () => pane,
      getPanes: () => [pane]
    }
  }
}

describe('terminal drop path writer', () => {
  it('stops writing dropped paths when the PTY rejects a path', async () => {
    const sendInput = vi.fn(() => true)
    const sendInputAccepted = vi.fn(async () => false)
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

    const result = await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/repo/a.ts', '/repo/b.ts'],
      targetShell: 'posix'
    })

    expect(result).toEqual({
      sentAnyPath: false,
      targetCurrent: false,
      pathsWritten: 0,
      failureReason: 'write-rejected'
    })
    expect(sendInputAccepted).toHaveBeenCalledTimes(1)
    expect(sendInputAccepted).toHaveBeenCalledWith('/repo/a.ts ')
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('times out dropped path writes that never receive PTY acknowledgement', async () => {
    vi.useFakeTimers()
    try {
      const sendInput = vi.fn(() => true)
      const sendInputAccepted = vi.fn(() => new Promise<boolean>(() => {}))
      const { manager, pane } = createManager()
      const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)

      const result = writeTerminalDropPathsToCapturedTarget({
        dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
        manager: manager as never,
        paneTransports: new Map([[pane.id, transport]]) as never,
        paths: ['/repo/a.ts'],
        targetShell: 'posix',
        operationTimeoutMs: 25
      })

      await vi.advanceTimersByTimeAsync(25)

      await expect(result).resolves.toEqual({
        sentAnyPath: false,
        targetCurrent: false,
        pathsWritten: 0,
        failureReason: 'operation-timeout'
      })
      expect(sendInputAccepted).toHaveBeenCalledTimes(1)
      expect(sendInput).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports partial writes when the captured target becomes stale between paths', async () => {
    const sendInput = vi.fn(() => true)
    let ptyId = 'pty-1'
    const sendInputAccepted = vi.fn(async () => {
      ptyId = 'pty-2'
      return true
    })
    const { manager, pane } = createManager()
    const transport = createTransport(sendInput, 'pty-1', sendInputAccepted)
    transport.getPtyId.mockImplementation(() => ptyId)

    const result = await writeTerminalDropPathsToCapturedTarget({
      dropTarget: { paneId: pane.id, leafId: pane.leafId, ptyId: 'pty-1', transport } as never,
      manager: manager as never,
      paneTransports: new Map([[pane.id, transport]]) as never,
      paths: ['/repo/a.ts', '/repo/b.ts'],
      targetShell: 'posix'
    })

    expect(result).toEqual({
      sentAnyPath: true,
      targetCurrent: false,
      pathsWritten: 1,
      failureReason: 'target-stale'
    })
    expect(sendInputAccepted).toHaveBeenCalledTimes(1)
  })
})
