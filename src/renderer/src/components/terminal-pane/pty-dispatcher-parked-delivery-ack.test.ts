import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: false } }))

const PTY_ID = 'pty-parked-ack'
const BOOT_OUTPUT = 'setup-script output'

type PtyDataPayload = { id: string; data: string; rawLength?: number }

describe('parked pty:data delivery credit', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  const ackData = vi.fn()
  let emitPtyData: (payload: PtyDataPayload) => void
  let emitPtyExit: (payload: { id: string; code: number }) => void

  function installWindow(options: { deliveryWatchdog: boolean }): void {
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          onData: (listener: (payload: PtyDataPayload) => void) => {
            emitPtyData = listener
            return () => {}
          },
          onReplay: () => () => {},
          onExit: (listener: (payload: { id: string; code: number }) => void) => {
            emitPtyExit = listener
            return () => {}
          },
          ackData,
          ...(options.deliveryWatchdog
            ? { reportRendererDeliveryState: vi.fn(async () => null) }
            : {})
        }
      }
    } as unknown as typeof window
  }

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    ackData.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('credits parked bytes immediately and does not credit them again on bind', async () => {
    installWindow({ deliveryWatchdog: true })
    const { ensurePtyDispatcher, registerEagerPtyBuffer } = await import('./pty-dispatcher')
    const { getParkedPreHandlerCharsByPty } = await import('./pty-pre-handler-buffer')
    ensurePtyDispatcher()

    emitPtyData({ id: PTY_ID, data: BOOT_OUTPUT })

    expect(ackData.mock.calls).toEqual([[PTY_ID, BOOT_OUTPUT.length, BOOT_OUTPUT.length]])
    expect(getParkedPreHandlerCharsByPty()).toEqual({ [PTY_ID]: BOOT_OUTPUT.length })

    // The real bind seam: registering the eager buffer drains the parked chunks.
    const handle = registerEagerPtyBuffer(PTY_ID, () => {})
    expect(handle.flush()).toBe(BOOT_OUTPUT)

    expect(ackData.mock.calls).toEqual([[PTY_ID, BOOT_OUTPUT.length, BOOT_OUTPUT.length]])
    expect(getParkedPreHandlerCharsByPty()).toEqual({})
  })

  it('credits the ACK at return on a surface with no delivery watchdog', async () => {
    installWindow({ deliveryWatchdog: false })
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    const { getParkedPreHandlerCharsByPty } = await import('./pty-pre-handler-buffer')
    const { clearPreHandlerPtyState } = await import('./pty-pre-handler-buffer')
    ensurePtyDispatcher()

    emitPtyData({ id: PTY_ID, data: BOOT_OUTPUT })

    // Consumer health remains observable without the optional invoke API.
    expect(ackData.mock.calls).toEqual([[PTY_ID, BOOT_OUTPUT.length, BOOT_OUTPUT.length]])
    expect(getParkedPreHandlerCharsByPty()).toEqual({ [PTY_ID]: BOOT_OUTPUT.length })
    clearPreHandlerPtyState(PTY_ID)
  })

  it('leaves a bound pane on parse-deferred ACK credit', async () => {
    installWindow({ deliveryWatchdog: true })
    const { ensurePtyDispatcher, ptyDataHandlers } = await import('./pty-dispatcher')
    const { takeCurrentPtyDeliveryAckCredit } = await import('./terminal-pty-ack-gate')
    ensurePtyDispatcher()
    let consumed: (() => void) | null = null
    ptyDataHandlers.set(PTY_ID, () => {
      consumed = takeCurrentPtyDeliveryAckCredit()
    })

    emitPtyData({ id: PTY_ID, data: BOOT_OUTPUT })
    expect(ackData).not.toHaveBeenCalled()
    expect(consumed).toBeTypeOf('function')
    ;(consumed as unknown as () => void)()
    expect(ackData.mock.calls).toEqual([[PTY_ID, BOOT_OUTPUT.length, BOOT_OUTPUT.length]])
  })

  it('retains startup output on exit without issuing another credit', async () => {
    installWindow({ deliveryWatchdog: true })
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    const { getParkedPreHandlerCharsByPty, drainPreHandlerPtyData } =
      await import('./pty-pre-handler-buffer')
    ensurePtyDispatcher()
    emitPtyData({ id: PTY_ID, data: BOOT_OUTPUT })
    emitPtyExit({ id: PTY_ID, code: 0 })
    expect(getParkedPreHandlerCharsByPty()).toEqual({ [PTY_ID]: BOOT_OUTPUT.length })
    const data: string[] = []
    drainPreHandlerPtyData(PTY_ID, (chunk) => data.push(chunk))
    expect(data).toEqual([BOOT_OUTPUT])
    expect(ackData.mock.calls).toEqual([[PTY_ID, BOOT_OUTPUT.length, BOOT_OUTPUT.length]])
  })

  it('leaves no processed-char total behind for the next incarnation of a reused id', async () => {
    installWindow({ deliveryWatchdog: true })
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    const { getProcessedPtyCharTotals } = await import('./terminal-pty-ack-gate')
    ensurePtyDispatcher()

    emitPtyData({ id: PTY_ID, data: BOOT_OUTPUT })
    emitPtyExit({ id: PTY_ID, code: 0 })

    // Settling ACKs on the way out, which re-adds to the cumulative total. Clearing before
    // delivery left that total re-seeded, and ids are reused — a redeployed relay renumbers
    // from pty-1 — so main credited the next incarnation for bytes nobody had parsed.
    expect(getProcessedPtyCharTotals()).toEqual({})
  })

  it('clears the processed total even when exit delivery itself credits an ACK', async () => {
    installWindow({ deliveryWatchdog: true })
    const { ensurePtyDispatcher, ptyExitHandlers } = await import('./pty-dispatcher')
    const { ackPtyData, getProcessedPtyCharTotals } = await import('./terminal-pty-ack-gate')
    ensurePtyDispatcher()

    // An exit owner that flushes buffered writes credits chars while the exit is delivered.
    // The clear has to be the last word on this id, whatever delivery did.
    ptyExitHandlers.set(PTY_ID, () => ackPtyData(PTY_ID, BOOT_OUTPUT.length))

    emitPtyExit({ id: PTY_ID, code: 0 })

    expect(ackData).toHaveBeenCalledWith(PTY_ID, BOOT_OUTPUT.length, BOOT_OUTPUT.length)
    expect(getProcessedPtyCharTotals()).toEqual({})
    ptyExitHandlers.delete(PTY_ID)
  })

  it('credits rawLength while reporting the actual retained characters', async () => {
    installWindow({ deliveryWatchdog: true })
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    const { getParkedPreHandlerCharsByPty } = await import('./pty-pre-handler-buffer')
    const { clearPreHandlerPtyState } = await import('./pty-pre-handler-buffer')
    ensurePtyDispatcher()

    // Main counts UTF-16 chars and says so via rawLength; the buffer counts UTF-8 bytes.
    emitPtyData({ id: PTY_ID, data: 'ééé', rawLength: 9 })

    expect(getParkedPreHandlerCharsByPty()).toEqual({ [PTY_ID]: 3 })
    clearPreHandlerPtyState(PTY_ID)
    expect(ackData.mock.calls).toEqual([[PTY_ID, 9, 9]])
  })

  it('clears delivery totals even when an exit consumer credits output and throws', async () => {
    installWindow({ deliveryWatchdog: true })
    const { ensurePtyDispatcher, ptyExitHandlers } = await import('./pty-dispatcher')
    const { ackPtyData, getProcessedPtyCharTotals } = await import('./terminal-pty-ack-gate')
    const { getTerminalDeliveryWatchdogDiagnostics } = await import('./terminal-delivery-watchdog')
    ensurePtyDispatcher()
    emitPtyData({ id: PTY_ID, data: BOOT_OUTPUT })
    ptyExitHandlers.set(PTY_ID, () => {
      ackPtyData(PTY_ID, 1)
      throw new Error('exit cleanup failed')
    })

    expect(() => emitPtyExit({ id: PTY_ID, code: 0 })).toThrow('exit cleanup failed')
    expect(getProcessedPtyCharTotals()).toEqual({})
    expect(getTerminalDeliveryWatchdogDiagnostics().receivedCharsByPty).toEqual({})
  })
})
