// @vitest-environment happy-dom
//
// Issue #21762: in a terminal pane running a TUI that enables mouse tracking
// (Claude Code, Codex, ...), a middle-click pastes the PRIMARY selection twice.
// Orca's own paste path bails out in tracking mode (correctly — the TUI owns
// the click), but bailing out also skips arming the native-paste suppression
// window from #8993, so Chromium's native "paste PRIMARY into focused editable"
// reaches xterm's helper textarea unsuppressed while the TUI performs its own
// primary paste from the forwarded mouse report — two copies from one click.
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { TerminalPaneContextController } from './use-terminal-pane-context-actions'

const { armPrimarySelectionNativePasteSuppressionMock, isPrimarySelectionEnabledMock } = vi.hoisted(
  () => ({
    armPrimarySelectionNativePasteSuppressionMock: vi.fn(),
    isPrimarySelectionEnabledMock: vi.fn(() => true)
  })
)

vi.mock('@/lib/primary-selection', () => ({
  armPrimarySelectionNativePasteSuppression: armPrimarySelectionNativePasteSuppressionMock,
  isPrimarySelectionEnabled: isPrimarySelectionEnabledMock,
  readPrimarySelectionText: vi.fn().mockResolvedValue('')
}))

vi.mock('@/lib/pane-manager/mobile-fit-overrides', () => ({ getMobileFitOverridePtyIds: () => [] }))
vi.mock('@/lib/pane-manager/mobile-driver-state', () => ({ getAllDrivers: () => new Map() }))
vi.mock('@/lib/pane-manager/pane-manager-registry', () => ({
  refitAndRefreshAllTerminalPanes: vi.fn()
}))
vi.mock('./terminal-fit-restore', () => ({
  restoreTerminalFitToDesktop: vi.fn(),
  restoreTerminalFitsToDesktop: vi.fn()
}))
vi.mock('./terminal-pane-split-with-inherited-cwd', () => ({
  splitTerminalPaneWithInheritedCwd: vi.fn()
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('./terminal-paste-coordinator', () => ({
  planTerminalPasteWithYield: vi.fn(),
  executeTerminalPastePlan: vi.fn()
}))
vi.mock('./terminal-paste-runtime', () => ({ resolveTerminalPasteRuntime: vi.fn() }))
vi.mock('./terminal-paste-ssh-platform', () => ({ getTerminalPasteSshRemotePlatform: vi.fn() }))
vi.mock('./terminal-bracketed-paste', () => ({ pasteTerminalText: vi.fn() }))
vi.mock('./terminal-pty-paste-writer', () => ({ writeTerminalPastePtyInput: vi.fn() }))
vi.mock('./terminal-paste-errors', () => ({ formatTerminalPasteExecutionError: vi.fn() }))
vi.mock('./terminal-input-activity', () => ({ recordTerminalUserInputForLeaf: vi.fn() }))

import { useTerminalPaneMobileActions } from './use-terminal-pane-mobile-actions'

function buildTrackedPane(mouseTrackingMode: 'none' | 'sgr'): ManagedPane {
  const container = document.createElement('div')
  document.body.appendChild(container)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only stub; the hook only reads id/leafId/container/terminal.modes/terminal.focus off ManagedPane.
  return {
    id: 1,
    leafId: 'leaf-1',
    container,
    terminal: {
      modes: { mouseTrackingMode, bracketedPasteMode: false },
      focus: vi.fn()
    }
  } as unknown as ManagedPane
}

function buildController(pane: ManagedPane): TerminalPaneContextController {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only stub; the hook only reads getPanes/getActivePane off PaneManager.
  const manager = {
    getPanes: () => [pane],
    getActivePane: () => pane
  } as unknown as PaneManager
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only stub covering only the controller fields useTerminalPaneMobileActions destructures.
  return {
    cwd: '/repo',
    managerRef: { current: manager },
    paneCwdRef: { current: new Map() },
    paneTransportsRef: { current: new Map() },
    refreshMobileOverlays: vi.fn(),
    setTerminalError: vi.fn(),
    settingsRef: { current: undefined },
    tabId: 'tab-1',
    worktreeId: 'wt-1'
  } as unknown as TerminalPaneContextController
}

function fireMiddleMouseDown(
  handler: (event: React.MouseEvent<HTMLDivElement>) => void,
  target: EventTarget,
  modifiers: { shiftKey?: boolean; altKey?: boolean } = {}
): { defaultPrevented: boolean; propagationStopped: boolean } {
  let defaultPrevented = false
  let propagationStopped = false
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only stub; the handler only reads button/target/shiftKey/altKey and calls preventDefault/stopPropagation off the event.
  handler({
    button: 1,
    target,
    shiftKey: modifiers.shiftKey ?? false,
    altKey: modifiers.altKey ?? false,
    preventDefault: () => {
      defaultPrevented = true
    },
    stopPropagation: () => {
      propagationStopped = true
    }
  } as unknown as React.MouseEvent<HTMLDivElement>)
  return { defaultPrevented, propagationStopped }
}

describe('issue 21762: middle-click native-paste suppression in mouse-tracking TUIs', () => {
  beforeEach(() => {
    armPrimarySelectionNativePasteSuppressionMock.mockClear()
    isPrimarySelectionEnabledMock.mockReturnValue(true)
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('arms native-paste suppression without stopping propagation when the pane is in mouse-tracking mode', () => {
    const pane = buildTrackedPane('sgr')
    const { result } = renderHook(() => useTerminalPaneMobileActions(buildController(pane)))

    const outcome = fireMiddleMouseDown(
      result.current.handlePrimarySelectionMiddleMouseDown,
      pane.container
    )

    // The #8993 suppression window must be armed so the native follow-up paste
    // doesn't reach xterm's helper textarea and duplicate the TUI's own paste.
    expect(armPrimarySelectionNativePasteSuppressionMock).toHaveBeenCalled()
    // Propagation must NOT be stopped here — xterm's own mousedown listener
    // (a descendant of this capture handler) still needs to see the event so
    // the tracking TUI receives the click as a mouse report.
    expect(outcome.propagationStopped).toBe(false)
    expect(pane.terminal.focus).not.toHaveBeenCalled()
  })

  it('stops propagation and pastes directly to the PTY when the pane is not in mouse-tracking mode', () => {
    const pane = buildTrackedPane('none')
    const { result } = renderHook(() => useTerminalPaneMobileActions(buildController(pane)))

    const outcome = fireMiddleMouseDown(
      result.current.handlePrimarySelectionMiddleMouseDown,
      pane.container
    )

    expect(armPrimarySelectionNativePasteSuppressionMock).toHaveBeenCalled()
    expect(outcome.propagationStopped).toBe(true)
    expect(pane.terminal.focus).toHaveBeenCalled()
  })

  // Follow-up to #21834: xterm withholds the mouse report for a shifted click
  // (SelectionService.shouldForceSelection), so the TUI never pastes. Arming
  // suppression while also returning early would leave nothing pasted at all.
  describe('Shift+middle-click in a mouse-tracking pane', () => {
    it("takes Orca's own paste path: stops propagation and focuses the pane", () => {
      const pane = buildTrackedPane('sgr')
      const { result } = renderHook(() => useTerminalPaneMobileActions(buildController(pane)))

      const outcome = fireMiddleMouseDown(
        result.current.handlePrimarySelectionMiddleMouseDown,
        pane.container,
        { shiftKey: true }
      )

      expect(armPrimarySelectionNativePasteSuppressionMock).toHaveBeenCalled()
      expect(outcome.defaultPrevented).toBe(true)
      expect(outcome.propagationStopped).toBe(true)
      expect(pane.terminal.focus).toHaveBeenCalled()
    })

    it('keeps the unshifted click on the TUI-owned path (no #21762 regression)', () => {
      const pane = buildTrackedPane('sgr')
      const { result } = renderHook(() => useTerminalPaneMobileActions(buildController(pane)))

      const outcome = fireMiddleMouseDown(
        result.current.handlePrimarySelectionMiddleMouseDown,
        pane.container,
        { shiftKey: false }
      )

      expect(armPrimarySelectionNativePasteSuppressionMock).toHaveBeenCalled()
      expect(outcome.propagationStopped).toBe(false)
      expect(pane.terminal.focus).not.toHaveBeenCalled()
    })

    // Guards against collapsing the modifier check to `shiftKey || altKey`:
    // off Mac, xterm still forwards an Alt+middle-click, so the TUI pastes.
    it('leaves Alt+middle-click on the TUI-owned path off Mac', () => {
      const pane = buildTrackedPane('sgr')
      const { result } = renderHook(() => useTerminalPaneMobileActions(buildController(pane)))

      const outcome = fireMiddleMouseDown(
        result.current.handlePrimarySelectionMiddleMouseDown,
        pane.container,
        { altKey: true }
      )

      expect(outcome.propagationStopped).toBe(false)
      expect(pane.terminal.focus).not.toHaveBeenCalled()
    })

    it('stops auxclick propagation too, matching the mousedown handler', () => {
      const pane = buildTrackedPane('sgr')
      const { result } = renderHook(() => useTerminalPaneMobileActions(buildController(pane)))

      const shifted = fireMiddleMouseDown(
        result.current.handlePrimarySelectionAuxClick,
        pane.container,
        {
          shiftKey: true
        }
      )
      const plain = fireMiddleMouseDown(
        result.current.handlePrimarySelectionAuxClick,
        pane.container
      )

      expect(armPrimarySelectionNativePasteSuppressionMock).toHaveBeenCalledTimes(2)
      expect(shifted.propagationStopped).toBe(true)
      expect(plain.propagationStopped).toBe(false)
    })

    it('on Mac follows xterm: Option, not Shift, forces the terminal to own the click', () => {
      const userAgent = vi.spyOn(navigator, 'userAgent', 'get')
      userAgent.mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
      try {
        const pane = buildTrackedPane('sgr')
        const { result } = renderHook(() => useTerminalPaneMobileActions(buildController(pane)))

        const shifted = fireMiddleMouseDown(
          result.current.handlePrimarySelectionMiddleMouseDown,
          pane.container,
          { shiftKey: true }
        )
        expect(shifted.propagationStopped).toBe(false)
        expect(pane.terminal.focus).not.toHaveBeenCalled()

        const optioned = fireMiddleMouseDown(
          result.current.handlePrimarySelectionMiddleMouseDown,
          pane.container,
          { altKey: true }
        )
        expect(optioned.propagationStopped).toBe(true)
        expect(pane.terminal.focus).toHaveBeenCalled()
      } finally {
        userAgent.mockRestore()
      }
    })
  })
})
