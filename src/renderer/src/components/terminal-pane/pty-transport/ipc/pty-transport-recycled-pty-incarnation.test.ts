/** Late prior-owner exits can pass the request-time sequence fence on recycled relay IDs; incarnation evidence must reject them without losing real pre-attach deaths (#16970). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installIpcPtyWindow,
  restorePtySpecWindow,
  type PtyExitPayload,
  type PtyStreamPayload
} from './pty-transport-test-harness'

const RECYCLED_PTY_ID = 'ssh:target@@pty-1'
const PRIOR_INCARNATION_ID = 'incarnation-before-the-relay-restarted'
const FRESH_INCARNATION_ID = 'incarnation-of-the-shell-now-attaching'

describe('createIpcPtyTransport against a relay-recycled PTY id', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onExit: ((payload: PtyExitPayload) => void) | null = null
  let onData: ((payload: PtyStreamPayload) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    onExit = null
    onData = null
    installIpcPtyWindow(originalWindow, {
      data: (callback) => {
        onData = callback
      },
      exit: (callback) => {
        onExit = callback
      }
    })
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  /** Emit inside spawn IPC so the buffered exit necessarily follows the request fence; only incarnation can prove it foreign. */
  async function connectWithExitDuringSpawn(
    exit: PtyExitPayload,
    spawnResponse: { id: string; incarnationId?: string }
  ): Promise<{ result: unknown; paneExit: ReturnType<typeof vi.fn> }> {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    spawn.mockImplementationOnce(() => {
      onExit?.(exit)
      return Promise.resolve(spawnResponse)
    })
    const paneExit = vi.fn()
    const transport = createIpcPtyTransport({})

    const result = await transport.connect({ url: '', callbacks: { onExit: paneExit } })
    return { result, paneExit }
  }

  it('does not report a fresh shell as exited when the id’s previous incarnation exits mid-spawn', async () => {
    const { result, paneExit } = await connectWithExitDuringSpawn(
      { id: RECYCLED_PTY_ID, code: 0, incarnationId: PRIOR_INCARNATION_ID },
      { id: RECYCLED_PTY_ID, incarnationId: FRESH_INCARNATION_ID }
    )

    // Require the PTY ID too; negative dead-result matching alone could pass a connect that bailed out.
    expect(result).toBe(RECYCLED_PTY_ID)
    expect(paneExit).not.toHaveBeenCalled()
  })

  // Legitimate death before handler registration must still be delivered to avoid binding an already-dead PTY.
  it('still reports an exit from the incarnation it actually attached to', async () => {
    const { result, paneExit } = await connectWithExitDuringSpawn(
      { id: RECYCLED_PTY_ID, code: 3, incarnationId: FRESH_INCARNATION_ID },
      { id: RECYCLED_PTY_ID, incarnationId: FRESH_INCARNATION_ID }
    )

    expect(result).toMatchObject({ id: RECYCLED_PTY_ID, exitedBeforeAttach: true })
    expect(paneExit).toHaveBeenCalledWith(3)
  })

  it('delivers an authentication failure and exit after the main-side binding cleanup', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = vi.mocked(window.api.pty.spawn)
    let release!: () => void
    const cleanup = new Promise<void>((resolve) => {
      release = resolve
    })
    spawn.mockImplementationOnce(async () => {
      onData?.({ id: RECYCLED_PTY_ID, data: 'Authentication failed: sign in again.\r\n' })
      onExit?.({ id: RECYCLED_PTY_ID, code: 1, incarnationId: FRESH_INCARNATION_ID })
      await cleanup
      return { id: RECYCLED_PTY_ID, incarnationId: FRESH_INCARNATION_ID }
    })
    const output = vi.fn()
    const exit = vi.fn()
    const error = vi.fn()
    const connected = vi.fn()
    const transport = createIpcPtyTransport()
    const pending = transport.connect({
      url: '',
      callbacks: {
        onData: output,
        onExit: exit,
        onError: error,
        onConnect: connected
      }
    })
    release()
    expect(await pending).toEqual({ id: RECYCLED_PTY_ID, exitedBeforeAttach: true })
    expect(output).toHaveBeenCalledWith('Authentication failed: sign in again.\r\n')
    expect(exit).toHaveBeenCalledWith(1)
    expect(output.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0])
    expect(error).not.toHaveBeenCalled()
    expect(connected).not.toHaveBeenCalled()
  })

  // Missing incarnation stays unknown for old-host/synthetic exits; remote-runtime exits use a different channel.
  it('never discards on incarnation when the host names none', async () => {
    const { result, paneExit } = await connectWithExitDuringSpawn(
      { id: RECYCLED_PTY_ID, code: 3 },
      { id: RECYCLED_PTY_ID }
    )

    expect(result).toMatchObject({ id: RECYCLED_PTY_ID, exitedBeforeAttach: true })
    expect(paneExit).toHaveBeenCalledWith(3)
  })
})
