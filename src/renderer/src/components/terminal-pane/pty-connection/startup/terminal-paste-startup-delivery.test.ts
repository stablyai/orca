import { afterEach, expect, it, vi } from 'vitest'
import { bindTerminalPasteStartupDelivery } from './terminal-paste-startup-delivery'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-setup', () => ({
  waitForRuntimeTerminalSetup: vi.fn(() => Promise.resolve())
}))
afterEach(() => {
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
