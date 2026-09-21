/** A restarted SSH relay renumbers PTYs from pty-1, so a fresh spawn is routinely handed an id
 *  whose previous shell is still emitting a late exit. Applying that exit to the new shell reports
 *  it as already dead (`exitedBeforeAttach`), the pane never binds a PTY, and the tab is blank and
 *  unusable forever — the runtime-proven failure behind #16970.
 *
 *  #16970 dated every buffered record and dropped anything older than the spawn request. That fence
 *  is a clock, so it cannot judge a stale exit that arrives AFTER the request left. These specs pin
 *  the identity rule that can: the incarnation names which lifetime of the id died. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installIpcPtyWindow,
  restorePtySpecWindow,
  type PtyExitPayload
} from './pty-transport-test-harness'

const RECYCLED_PTY_ID = 'ssh:target@@pty-1'
const PRIOR_INCARNATION_ID = 'incarnation-before-the-relay-restarted'
const FRESH_INCARNATION_ID = 'incarnation-of-the-shell-now-attaching'

describe('createIpcPtyTransport against a relay-recycled PTY id', () => {
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

  /** Deliver `exit` while the spawn request is in flight, then settle the spawn.
   *
   *  Firing from inside the spawn mock makes "after the request left the renderer" *definitional*
   *  rather than microtask-scheduled: the fence is read before `spawnIpcPty` is called, so an exit
   *  buffered during the call is always newer than the fence. That is the whole point — the fence
   *  keeps this record, and only the incarnation can reject it. */
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

    // Positive, not just "not dead": a bare `not.toMatchObject` would also pass on a bailed-out
    // connect that returned undefined. A healthy fresh spawn resolves to its pty id.
    expect(result).toBe(RECYCLED_PTY_ID)
    expect(paneExit).not.toHaveBeenCalled()
  })

  // The reason the pre-handler buffer exists: a shell that dies before the pane registers its exit
  // handler must still be reported, or the pane hangs on a PTY that is already gone.
  it('still reports an exit from the incarnation it actually attached to', async () => {
    const { result, paneExit } = await connectWithExitDuringSpawn(
      { id: RECYCLED_PTY_ID, code: 3, incarnationId: FRESH_INCARNATION_ID },
      { id: RECYCLED_PTY_ID, incarnationId: FRESH_INCARNATION_ID }
    )

    expect(result).toMatchObject({ id: RECYCLED_PTY_ID, exitedBeforeAttach: true })
    expect(paneExit).toHaveBeenCalledWith(3)
  })

  // Absence is unknown, never a mismatch — so an SSH host predating the field, and the relay's own
  // unnamed `{ id, code: -1 }` drop, keep exactly the behaviour #16970 shipped. (`remote:` runtime
  // PTYs are not covered by this: their exits never traverse `pty:exit` at all.)
  it('never discards on incarnation when the host names none', async () => {
    const { result, paneExit } = await connectWithExitDuringSpawn(
      { id: RECYCLED_PTY_ID, code: 3 },
      { id: RECYCLED_PTY_ID }
    )

    expect(result).toMatchObject({ id: RECYCLED_PTY_ID, exitedBeforeAttach: true })
    expect(paneExit).toHaveBeenCalledWith(3)
  })
})
