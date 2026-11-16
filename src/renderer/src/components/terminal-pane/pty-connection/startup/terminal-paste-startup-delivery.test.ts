import { afterEach, expect, it, vi } from 'vitest'
import { waitForTerminalOutputParsed } from '@/lib/pane-manager/terminal-output/pane-terminal-output-scheduler'
import { waitForRuntimeTerminalSetup } from '@/runtime/hosted-terminals/inspection/runtime-terminal-setup'
import { executeTerminalStartupCommandPaste } from '../../input/paste/terminal-startup-command-paste'
import { bindTerminalPasteStartupDelivery } from './terminal-paste-startup-delivery'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-setup', () => ({
  waitForRuntimeTerminalSetup: vi.fn(() => Promise.resolve())
}))
vi.mock('@/lib/pane-manager/terminal-output/pane-terminal-output-scheduler', () => ({
  waitForTerminalOutputParsed: vi.fn(() => Promise.resolve())
}))
vi.mock('../../input/paste/terminal-startup-command-paste', () => ({
  executeTerminalStartupCommandPaste: vi.fn(async () => ({ status: 'pasted' }))
}))
afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each([300, 3000])(
  'does no cancellation work for %s output chunks without a startup command',
  (chunks) => {
    const RealAbortController = AbortController
    const controller = vi.fn(class extends RealAbortController {})
    vi.stubGlobal('AbortController', controller)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the inactive scheduling path reads only pendingStartupCommand and waitTeardowns.
    const session = {
      pendingStartupCommand: null,
      waitTeardowns: []
    } as unknown as ConnectPanePtySession
    bindTerminalPasteStartupDelivery(session)
    for (let index = 0; index < chunks; index++) {
      session.schedulePendingStartupCommandDelivery()
    }
    session.waitTeardowns.forEach((stop) => stop())
    expect(controller).not.toHaveBeenCalled()
  }
)

it.each([false, true])(
  'retires a parser-overlapped delivery before Setup settles (failure: %s)',
  async (failure) => {
    vi.useFakeTimers()
    const parsing = Promise.withResolvers<void>()
    const setup = Promise.withResolvers<void>()
    vi.mocked(waitForTerminalOutputParsed).mockImplementation(() => parsing.promise)
    vi.mocked(waitForRuntimeTerminalSetup).mockImplementation(() => setup.promise)
    const transport = { getPtyId: () => 'pty', sendInput: vi.fn(() => true) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the delivery seam reads only the scheduling, transport and pane fields supplied here.
    const session = {
      disposed: false,
      waitTeardowns: [],
      pendingStartupCommand: { command: 'codex --model chosen' },
      startupInjectTimer: null,
      transportStreamGeneration: 1,
      transport,
      shouldDeliverStartupViaTerminalPaste: true,
      isNativeWindowsConpty: false,
      pane: { id: 1, terminal: {} },
      deps: {
        paneTransportsRef: { current: new Map([[1, transport]]) },
        onPtyErrorRef: { current: vi.fn() }
      },
      armStartupDraftReadinessObservation: vi.fn(),
      releaseUnattemptedStartupDraftPasteDelivery: vi.fn()
    } as unknown as ConnectPanePtySession
    bindTerminalPasteStartupDelivery(session)
    session.schedulePendingStartupCommandDelivery()
    await vi.advanceTimersByTimeAsync(50)
    session.schedulePendingStartupCommandDelivery()
    await vi.advanceTimersByTimeAsync(50)
    parsing.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(waitForRuntimeTerminalSetup).toHaveBeenCalledOnce()
    if (failure) {
      setup.reject(new Error('Setup failed'))
      await vi.advanceTimersByTimeAsync(0)
      expect(session.deps.onPtyErrorRef?.current).toHaveBeenCalledOnce()
      expect(transport.sendInput).not.toHaveBeenCalled()
    } else {
      vi.mocked(executeTerminalStartupCommandPaste).mockImplementationOnce(async () => {
        session.schedulePendingStartupCommandDelivery()
        await Promise.resolve()
        return { status: 'pasted' }
      })
      setup.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(executeTerminalStartupCommandPaste).toHaveBeenCalledOnce()
      expect(executeTerminalStartupCommandPaste).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'codex --model chosen' })
      )
      expect(transport.sendInput).toHaveBeenCalledExactlyOnceWith('\r', 'launch')
      expect(session.pendingStartupCommand).toBeNull()
    }
    session.waitTeardowns.forEach((stop) => stop())
  }
)
