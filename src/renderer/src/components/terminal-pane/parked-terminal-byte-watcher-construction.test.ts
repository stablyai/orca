import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ParkedTerminalCommandStatus from './parked-terminal-command-status'

const PTY_ID = 'pty-construction-failure'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

const commandStatusPolicy = {
  onCommandFinished: vi.fn(),
  onCommandCodeWorking: vi.fn(),
  onCommandCodeDone: vi.fn(),
  dispose: vi.fn()
}

vi.mock('./parked-terminal-command-status', async (importOriginal) => ({
  ...(await importOriginal<typeof ParkedTerminalCommandStatus>()),
  createParkedTerminalCommandStatusPolicy: vi.fn(() => commandStatusPolicy)
}))

vi.mock('@/lib/terminal-theme', () => ({ getSystemPrefersDark: () => true }))
vi.mock('./use-notification-dispatch', () => ({ dispatchTerminalNotification: vi.fn() }))

const storeState = {
  settings: { theme: 'system', terminalMainSideEffectAuthority: false },
  agentStatusByPaneKey: {},
  markWorktreeUnread: vi.fn(),
  markTerminalTabUnread: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))

describe('parked terminal byte watcher construction', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let dispatchData: ((payload: { id: string; data: string }) => void) | null
  let setPtyDeliveryInterest: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    commandStatusPolicy.dispose.mockClear()
    storeState.settings.terminalMainSideEffectAuthority = false
    storeState.markWorktreeUnread.mockReset()
    storeState.markTerminalTabUnread.mockReset()
    dispatchData = null
    setPtyDeliveryInterest = vi.fn()
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          ackData: vi.fn(),
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            dispatchData = callback
            return () => {}
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {}),
          setPtyDeliveryInterest
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('rolls back partial resources when buffered adoption throws', async () => {
    const { ensurePtyDispatcher, ptyDataSidecars } = await import('./pty-dispatcher')
    const { drainPreHandlerPtyData } = await import('./pty-pre-handler-buffer')
    const { startParkedTerminalByteWatcher } = await import('./parked-terminal-byte-watcher')
    const sendError = new Error('PTY write failed')
    ensurePtyDispatcher()
    dispatchData?.({ id: PTY_ID, data: '\x1b[?2031h' })

    expect(() =>
      startParkedTerminalByteWatcher({
        ptyId: PTY_ID,
        tabId: 'tab-1',
        worktreeId: 'worktree-1',
        leafId: LEAF_ID,
        paneId: 1,
        sendInput: () => {
          throw sendError
        }
      })
    ).toThrow(sendError)

    expect(commandStatusPolicy.dispose).toHaveBeenCalledOnce()
    expect(ptyDataSidecars.has(PTY_ID)).toBe(false)
    expect(setPtyDeliveryInterest.mock.calls).toEqual([
      [PTY_ID, true],
      [PTY_ID, false]
    ])
    const laterPrimary = vi.fn()
    drainPreHandlerPtyData(PTY_ID, laterPrimary)
    expect(laterPrimary).not.toHaveBeenCalled()
  })

  it('disposes its policy when buffered fact registration throws', async () => {
    const { _dispatchTerminalSideEffectBatchForTest, registerTerminalSideEffectFactConsumer } =
      await import('./terminal-side-effect-facts-handler')
    const { startParkedTerminalByteWatcher } = await import('./parked-terminal-byte-watcher')
    const seed = registerTerminalSideEffectFactConsumer({ ptyId: PTY_ID, callbacks: {} })
    seed()
    _dispatchTerminalSideEffectBatchForTest({
      ptyId: PTY_ID,
      seq: 1,
      facts: [{ kind: 'bell' }]
    })
    const factError = new Error('fact callback failed')
    storeState.settings.terminalMainSideEffectAuthority = true
    storeState.markWorktreeUnread.mockImplementation(() => {
      throw factError
    })

    expect(() =>
      startParkedTerminalByteWatcher({
        ptyId: PTY_ID,
        tabId: 'tab-1',
        worktreeId: 'worktree-1',
        leafId: LEAF_ID,
        paneId: 1,
        sendInput: vi.fn()
      })
    ).toThrow(factError)
    expect(commandStatusPolicy.dispose).toHaveBeenCalledOnce()

    expect(() =>
      _dispatchTerminalSideEffectBatchForTest({
        ptyId: PTY_ID,
        seq: 2,
        facts: [{ kind: 'bell' }]
      })
    ).not.toThrow()
    const replacementBell = vi.fn()
    registerTerminalSideEffectFactConsumer({
      ptyId: PTY_ID,
      callbacks: { onBell: replacementBell }
    })
    expect(replacementBell).toHaveBeenCalledOnce()
  })
})
