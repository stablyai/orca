import { describe, expect, it, vi } from 'vitest'
import { bindWritePtyOutputToXterm } from './write-pty-output-to-xterm'
import { createInteractiveEchoLatencyTracker } from './interactive-echo-latency'

const writeTerminalOutput = vi.hoisted(() => vi.fn())
const forceFullViewportPresent = vi.hoisted(() => vi.fn())

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  writeTerminalOutput
}))

vi.mock('@/lib/pane-manager/terminal-render-pause-release', () => ({
  forceFullViewportPresent
}))

vi.mock('@/lib/pane-manager/terminal-delivery-credit', () => ({
  takeCurrentTerminalDeliveryCredit: vi.fn(() => undefined)
}))

function createSession(startupOnParsed: () => void) {
  const terminal = {}
  return {
    kittyKeyboardModes: { scan: vi.fn() },
    resetHiddenOutputRestoreIfPtyChanged: vi.fn(),
    transport: { getPtyId: vi.fn(() => 'pty-1') },
    canUseHiddenOutputSnapshot: vi.fn(() => false),
    shouldSnapshotHiddenCodexOutput: false,
    shouldProtectNativeWindowsSynchronizedOutput: true,
    shouldApplyNativeWindowsRewriteRefresh: false,
    synchronizedForegroundMarkerTail: '',
    synchronizedForegroundOutputActive: true,
    synchronizedForegroundFrameInteractive: false,
    synchronizedForegroundInteractivePresentPending: true,
    lastTerminalInputAt: 0,
    interactiveEchoLatency: createInteractiveEchoLatencyTracker(),
    scheduleForegroundGridDriftCheck: vi.fn(),
    shouldForceForegroundRenderRefresh: vi.fn(() => ({ refresh: false, inPlaceRewrite: false })),
    isLatencySensitiveForegroundOutput: vi.fn(() => false),
    shouldRefreshForegroundSynchronously: false,
    beforeTerminalOutputWrite: undefined,
    markHiddenOutputRestoreNeeded: vi.fn(),
    startupTiming: {
      firstWrite: vi.fn(() => ({ beforeWrite: vi.fn(), onParsed: startupOnParsed }))
    },
    writePtyOutputToXterm: vi.fn(),
    pane: { terminal }
  }
}

describe('bindWritePtyOutputToXterm startup callbacks', () => {
  it('composes startup timing and synchronized-frame presentation callbacks', () => {
    const startupOnParsed = vi.fn()
    const session = createSession(startupOnParsed)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies exactly the fields read by this isolated binding test.
    bindWritePtyOutputToXterm(session as never)

    session.writePtyOutputToXterm?.('\x1b[?2026hframe', true, { liveStartupBatch: true })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scheduler mock receives the binding's documented options object.
    const options = writeTerminalOutput.mock.calls[0]?.[2] as {
      onParsed?: () => void
    }
    options.onParsed?.()

    expect(startupOnParsed).toHaveBeenCalledOnce()
    expect(forceFullViewportPresent).toHaveBeenCalledWith(session.pane.terminal)
  })
})
