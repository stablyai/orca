// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildPtyProcessInspectionWireResult,
  type PtyProcessInspectionEvidence
} from '../../../../shared/pty-process-inspection-evidence'

/**
 * The window-close guard is the one consumer of this evidence that acts FOR the
 * user: a degraded probe read as "nothing is running" skips the prompt entirely
 * and the window closes on live work. So every case is asserted on the dialog
 * text rendered into a real DOM and on whether confirmWindowClose() fired —
 * never on an intermediate boolean.
 */

const { getStateMock } = vi.hoisted(() => ({ getStateMock: vi.fn() }))

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/shutdown-checkpoint-failure-toast', () => ({
  showShutdownCheckpointFailureToast: vi.fn()
}))

import { showShutdownCheckpointFailureToast } from '@/lib/shutdown-checkpoint-failure-toast'
import {
  dispatchWindowCloseRequest,
  registerWindowCloseGuard,
  setWindowCloseRequestHandler
} from '../window-close-request-coordinator'
import { useWindowCloseRunningProcessPrompt } from './window-close-running-process-prompt'
import { anyLocalPtyBlocksWindowClose } from './window-close-running-process-evidence'
import { RUNNING_CLOSE_PROBE_TIMEOUT_MS } from './running-terminal-close-guard'

const PTY_ID = 'pty-local-1'
const SHELL = 'zsh'
const WARNING = 'There are local terminals with running processes.'

/**
 * What `LocalPtyProvider.inspectProcess` really publishes when the foreground
 * scan is degraded (`classifyLocalPtyChildProcesses`, "pty title matches the
 * shell while the foreground scan is degraded"): the legacy fields are the
 * stable-cache shell name and `hasChildProcesses: false`, byte-identical to a
 * genuinely idle shell. Composed through the real collapse builder so the
 * fixture cannot drift from the producer.
 */
type InspectionShape = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  unavailable?: true
  processEvidence?: PtyProcessInspectionEvidence
}

function degradedLocalInspection(): InspectionShape {
  return {
    ...buildPtyProcessInspectionWireResult(
      { verdict: 'unverifiable', reason: 'process table scan degraded' },
      {
        verdict: 'unverifiable',
        reason: 'pty title matches the shell while the foreground scan is degraded'
      }
    ),
    // The provider publishes its stable-cache legacy value, which for a pane
    // that never ran an agent is the shell name.
    foregroundProcess: SHELL
  }
}

function observedIdleInspection(): InspectionShape {
  return buildPtyProcessInspectionWireResult(
    { verdict: 'observed', processName: SHELL },
    { verdict: 'exited' }
  )
}

function observedLiveInspection(): InspectionShape {
  return buildPtyProcessInspectionWireResult(
    { verdict: 'observed', processName: 'codex' },
    { verdict: 'live' }
  )
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let confirmWindowClose: ReturnType<typeof vi.fn>
let proceed: ((isQuitting: boolean) => void) | null = null

function Harness(): React.ReactNode {
  const prompt = useWindowCloseRunningProcessPrompt()
  proceed = prompt.proceedToNativeWindowClose
  return prompt.windowCloseDialog
}

/**
 * Installs a PTY inspection that RESOLVES with a degraded answer — the shape the
 * bug actually has. A throwing controller would be a different boundary; the
 * local host answers, its probes just could not see.
 */
function installInspectProcess(inspectProcess: () => Promise<InspectionShape>): void {
  ;(window as unknown as { api: unknown }).api = {
    pty: {
      inspectProcess: vi.fn(inspectProcess),
      // Why the double publishes both: `pty:hasChildProcesses` is the legacy
      // boolean route this guard used to take, and it is derived from the SAME
      // host answer. A double that omitted it would let the pre-fix predicate
      // look untestable instead of wrong.
      hasChildProcesses: vi.fn(async () => (await inspectProcess()).hasChildProcesses === true)
    },
    ui: { confirmWindowClose }
  }
}

/**
 * Drives the real entry point. Why not call `proceedToNativeWindowClose` directly:
 * the request id that fences a stale probe is advanced by the coordinator, above
 * every branch, so a test that skips the coordinator cannot tell two requests apart
 * and would pass on code that closes a cancelled window.
 */
async function requestWindowClose(isQuitting = false): Promise<void> {
  await act(async () => {
    await dispatchWindowCloseRequest({ isQuitting })
    await Promise.resolve()
  })
}

async function runWindowClose(): Promise<void> {
  await act(async () => {
    await dispatchWindowCloseRequest({ isQuitting: false })
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Two overlapping close attempts: main re-sends `window:close-requested` on every one
 *  (main-window-close-lifecycle.ts), the coordinator's `closeInFlight` is released before
 *  the handler runs, and Terminal's re-entrancy ref only trips on dirty editors — so both
 *  probes are live at once and the older one must not get to decide. */
function installDeferredInspections(): ((value: InspectionShape) => void)[] {
  const settle: ((value: InspectionShape) => void)[] = []
  installInspectProcess(() => new Promise<InspectionShape>((resolve) => settle.push(resolve)))
  return settle
}

function warningIsVisible(): boolean {
  return document.body.textContent?.includes(WARNING) === true
}

beforeEach(() => {
  vi.mocked(showShutdownCheckpointFailureToast).mockClear()
  confirmWindowClose = vi.fn()
  getStateMock.mockReturnValue({
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
    ptyIdsByTabId: { 'tab-1': [PTY_ID] }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<Harness />)
  })
  // Terminal's registered handler, minus the branches each test installs itself.
  setWindowCloseRequestHandler(({ isQuitting }) => proceed!(isQuitting))
})

afterEach(() => {
  setWindowCloseRequestHandler(null)
  act(() => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
  proceed = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('window close with a degraded local process read', () => {
  it('shows the running-processes warning instead of closing the window', async () => {
    installInspectProcess(async () => degradedLocalInspection())

    await runWindowClose()

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('still closes silently when the probe positively observed an idle shell', async () => {
    installInspectProcess(async () => observedIdleInspection())

    await runWindowClose()

    expect(warningIsVisible()).toBe(false)
    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })

  it('shows the warning for an observed live process', async () => {
    installInspectProcess(async () => observedLiveInspection())

    await runWindowClose()

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('asks when the host could not route the pane at all', async () => {
    // `pty:inspectProcess` answers exactly this for an id it cannot route, and
    // `inspectPtyProviderProcessForRenderer` answers it on terminal_gone. The
    // legacy fields it carries are the idle collapse, so without an `unavailable`
    // fence the evidence read fabricates `exited` from nothing anyone observed.
    installInspectProcess(async () => ({
      foregroundProcess: null,
      hasChildProcesses: false,
      unavailable: true as const
    }))

    await runWindowClose()

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('asks when the inspection raises instead of leaving the window stuck', async () => {
    installInspectProcess(async () => {
      throw new Error('inspect failed')
    })

    await runWindowClose()

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  function clickCancel(): void {
    const cancel = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Cancel'
    )
    expect(cancel).toBeDefined()
    act(() => {
      cancel!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('does not close the window on a stale probe after the user cancelled a newer one', async () => {
    const settle = installDeferredInspections()

    await requestWindowClose()
    await requestWindowClose()
    expect(settle).toHaveLength(2)

    // The newer attempt answers first and finds live work, so the warning goes up.
    await act(async () => {
      settle[1]!(observedLiveInspection())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(warningIsVisible()).toBe(true)

    // The user chooses to keep the window.
    clickCancel()
    expect(warningIsVisible()).toBe(false)

    // The older probe finally settles, reporting a table it read before the dialog existed.
    await act(async () => {
      settle[0]!(observedIdleInspection())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(confirmWindowClose).not.toHaveBeenCalled()
    expect(warningIsVisible()).toBe(false)
  })

  it('does not reopen a dismissed warning when a stale probe reports live work', async () => {
    const settle = installDeferredInspections()

    await requestWindowClose()
    await requestWindowClose()

    await act(async () => {
      settle[1]!(observedLiveInspection())
      await Promise.resolve()
      await Promise.resolve()
    })
    clickCancel()
    expect(warningIsVisible()).toBe(false)

    await act(async () => {
      settle[0]!(observedLiveInspection())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(warningIsVisible()).toBe(false)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  /** The newest attempt is not automatically the user's newest intent. Cancel is,
   *  and a probe that was already outstanding when they pressed it still belongs to
   *  a close they have since called off. */
  it('does not close the window on a probe the user cancelled out from under', async () => {
    const settle = installDeferredInspections()

    await requestWindowClose()
    await act(async () => {
      settle[0]!(observedLiveInspection())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(warningIsVisible()).toBe(true)

    // A second attempt lands while the warning is still asking — the traffic
    // lights stay clickable under it — so its probe is the newest one.
    await requestWindowClose()

    clickCancel()
    expect(warningIsVisible()).toBe(false)

    await act(async () => {
      settle[1]!(observedIdleInspection())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  /** Keeps the newest-attempt fence pinned on its own. Both cancel cases above are
   *  also satisfied by the dismissal fence, so without a case that never cancels,
   *  deleting the per-attempt bump leaves every test green. */
  it('does not let an older idle probe close the window while the newer one is still asking', async () => {
    const settle = installDeferredInspections()

    await requestWindowClose()
    await requestWindowClose()

    await act(async () => {
      settle[1]!(observedLiveInspection())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(warningIsVisible()).toBe(true)

    await act(async () => {
      settle[0]!(observedIdleInspection())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(confirmWindowClose).not.toHaveBeenCalled()
    expect(warningIsVisible(), 'the warning must stay up until the user answers it').toBe(true)
  })

  /** The close paths that never probe end an attempt just as surely as the ones that do.
   *  A quit arrives on the same re-sent `window:close-requested` and skips the probe
   *  entirely, and its shutdown checkpoint can veto it — which leaves the window open
   *  with the earlier attempt's probe still outstanding. `vetoNextCloses` is the real
   *  producer: `confirmNativeWindowClose` reads `window.dispatchEvent`'s own return. */
  function vetoNextCloses(): () => void {
    const veto = (event: Event): void => event.preventDefault()
    window.addEventListener('beforeunload', veto)
    return () => window.removeEventListener('beforeunload', veto)
  }

  it('does not reopen the warning on a probe left over from before a vetoed direct close', async () => {
    const settle = installDeferredInspections()

    await requestWindowClose()
    expect(settle).toHaveLength(1)

    // The user hits Cmd+Q while the first probe is still out. A quit never probes,
    // and the dirty-file checkpoint vetoes it, so the window simply stays open.
    const stopVetoing = vetoNextCloses()
    try {
      await requestWindowClose(true)
      expect(confirmWindowClose).not.toHaveBeenCalled()
      expect(vi.mocked(showShutdownCheckpointFailureToast)).toHaveBeenCalledTimes(1)

      // The abandoned probe answers, for a close request that has already returned.
      await act(async () => {
        settle[0]!(observedLiveInspection())
        await Promise.resolve()
        await Promise.resolve()
      })
    } finally {
      stopVetoing()
    }

    expect(warningIsVisible(), 'a settled close attempt must not raise a dialog').toBe(false)
  })

  it('does not re-run a vetoed direct close from a probe that answers idle behind it', async () => {
    const settle = installDeferredInspections()

    await requestWindowClose()

    const stopVetoing = vetoNextCloses()
    try {
      await requestWindowClose(true)
      expect(vi.mocked(showShutdownCheckpointFailureToast)).toHaveBeenCalledTimes(1)

      // Why the toast count and not `confirmWindowClose`: the veto is a standing
      // dirty-file guard, so a re-run is refused too and the close call alone cannot
      // tell a fenced probe from a re-vetoed one. The duplicate failure toast is the
      // observable — a second shutdown report for a close the user never asked for.
      await act(async () => {
        settle[0]!(observedIdleInspection())
        await Promise.resolve()
        await Promise.resolve()
      })
    } finally {
      stopVetoing()
    }

    expect(
      vi.mocked(showShutdownCheckpointFailureToast),
      'the stale probe must not drive the close sequence a second time'
    ).toHaveBeenCalledTimes(1)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('still closes the window directly on a quit that no checkpoint vetoes', async () => {
    installInspectProcess(async () => observedLiveInspection())

    await requestWindowClose(true)

    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
    expect(vi.mocked(showShutdownCheckpointFailureToast)).not.toHaveBeenCalled()
  })

  it('reads a malformed foreign evidence payload as unverifiable, not as idle', async () => {
    installInspectProcess(async () => ({
      foregroundProcess: SHELL,
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'bogus' },
        children: { verdict: 'bogus' }
      } as unknown as PtyProcessInspectionEvidence
    }))

    await runWindowClose()

    expect(warningIsVisible()).toBe(true)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })
})

/**
 * Terminal.tsx is the only caller, and the guard is bypassable there with every
 * suite, `tsc` and oxlint still green. Mounting a 2800-line component to prove
 * the wiring costs far more than it returns, so pin it as source text the same
 * way initial-terminal-wiring.test.ts does.
 */
describe('Terminal.tsx routes the native window-close request through the guard', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/Terminal.tsx'),
    'utf8'
  )

  it('registers a handler that probes before closing', () => {
    // Anchored on the effect's indent so a comment or a hoisted helper of the
    // same name cannot stand in for the registered handler.
    const start = source.indexOf('    setWindowCloseRequestHandler(({ isQuitting }) => {')
    const end = source.indexOf('    return () => setWindowCloseRequestHandler(null)', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(source.slice(start, end)).toContain('proceedToNativeWindowClose(isQuitting)')
  })

  it('still defers a dirty-editor close instead of probing, as the stand-in handler does', () => {
    // Why pin the branch: the fenced-probe cases above drive a hand-written copy of
    // this handler, and the branch that produced the bug is the one that returns
    // WITHOUT calling proceedToNativeWindowClose. If Terminal ever probed here
    // instead, the copy would be testing a shape Terminal no longer has.
    const start = source.indexOf('    setWindowCloseRequestHandler(({ isQuitting }) => {')
    const end = source.indexOf('    return () => setWindowCloseRequestHandler(null)', start)
    const handler = source.slice(start, end)
    const dirtyBranch = handler.slice(
      handler.indexOf('const dirtyFiles'),
      handler.indexOf('proceedToNativeWindowClose(isQuitting)')
    )
    expect(dirtyBranch).toContain('queueEditorCloseRequests(')
    expect(dirtyBranch).toContain('return')
    // The duplicate-quit drop is the other non-probing exit the copy reproduces.
    expect(handler).toContain('if (windowCloseAfterDirtyRef.current) {')
  })

  it('keeps the intentional-restart bypass the only unprobed close', () => {
    // Why a count: swapping the handler's call for a direct confirmWindowClose()
    // restores the silent close this file exists to prevent, and nothing else in
    // the tree observes it.
    expect(
      source.split('window.api.ui.confirmWindowClose(').length - 1,
      'Terminal.tsx may only close the window unprobed for an intentional app restart'
    ).toBe(1)
  })
})

/**
 * A local inspect is an IPC round trip into a process-table scan, and this path has
 * no backstop anywhere: main arms its renderer-ack timer only when `isQuitting`,
 * and that is precisely the branch that never probes. An unbounded wait therefore
 * leaves the window neither closed nor prompting — the same silent death the guard
 * exists to remove, arriving through a stall instead of a wrong verdict.
 */
describe('a probe that never answers cannot hang the window close', () => {
  it('blocks once the deadline passes instead of waiting forever', async () => {
    installInspectProcess(() => new Promise(() => {}))

    await expect(
      anyLocalPtyBlocksWindowClose({ activeRuntimeEnvironmentId: null }, [PTY_ID], 20)
    ).resolves.toBe(true)
  })

  it('still returns the real answer when the probe beats the deadline', async () => {
    installInspectProcess(async () => observedIdleInspection())

    await expect(
      anyLocalPtyBlocksWindowClose({ activeRuntimeEnvironmentId: null }, [PTY_ID], 20_000)
    ).resolves.toBe(false)
  })

  it('bounds the window-close probe with the same deadline as the tab and pane close paths', async () => {
    vi.useFakeTimers()
    try {
      installInspectProcess(() => new Promise(() => {}))
      await requestWindowClose()
      // Why assert the not-yet state first: without it a bound of 0 would pass.
      expect(warningIsVisible()).toBe(false)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RUNNING_CLOSE_PROBE_TIMEOUT_MS)
      })
      expect(warningIsVisible()).toBe(true)
      expect(confirmWindowClose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * A window-close request can leave the renderer without ever reaching
 * `proceedToNativeWindowClose` — a pre-close guard can veto it in the coordinator,
 * and Terminal defers it behind the unsaved-changes dialog. Both end the previous
 * attempt just as surely as a probe-taking one does, so both must be driven through
 * the real entry point rather than through the hook's own function.
 */
describe('a request that never reaches the probe still ends the previous attempt', () => {
  const unregisterGuards: (() => void)[] = []

  afterEach(() => {
    setWindowCloseRequestHandler(null)
    unregisterGuards.splice(0).forEach((unregister) => unregister())
  })

  it('does not close the window on a probe outstanding when a guard vetoed the next request', async () => {
    // The Settings unsaved-author-prompt guard is the real producer: it returns false
    // when the user picks Cancel, and the coordinator then returns with the window open.
    setWindowCloseRequestHandler(({ isQuitting }) => proceed!(isQuitting))
    const settle = installDeferredInspections()

    await requestWindowClose()
    expect(settle).toHaveLength(1)

    unregisterGuards.push(registerWindowCloseGuard(() => false))
    await requestWindowClose()
    // The vetoed request never reached the handler, so no second probe exists.
    expect(settle).toHaveLength(1)

    await act(async () => {
      settle[0]!(observedIdleInspection())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      confirmWindowClose,
      'a probe from a request the user has since vetoed must not close the window'
    ).not.toHaveBeenCalled()
  })

  /**
   * Terminal's registered handler in miniature: the three branches it takes before
   * the probe, plus the unsaved-changes Cancel that abandons the deferred close.
   * Pinned against the real source below so it cannot drift into a shape Terminal
   * does not have.
   */
  function installTerminalShapedHandler(): {
    setDirty: (dirty: boolean) => void
    cancelUnsavedChangesDialog: () => void
  } {
    let dirty = false
    let windowCloseAfterDirty: { isQuitting: boolean } | null = null
    setWindowCloseRequestHandler(({ isQuitting }) => {
      if (windowCloseAfterDirty) {
        return
      }
      if (dirty) {
        windowCloseAfterDirty = { isQuitting }
        return
      }
      proceed!(isQuitting)
    })
    return {
      setDirty: (next) => {
        dirty = next
      },
      cancelUnsavedChangesDialog: () => {
        windowCloseAfterDirty = null
      }
    }
  }

  it('does not close the window on a probe outstanding when the user cancelled a deferred close', async () => {
    const terminal = installTerminalShapedHandler()
    const settle = installDeferredInspections()

    await requestWindowClose()
    expect(settle).toHaveLength(1)

    // The user edits a file while the probe is still out, then closes again: the
    // unsaved-changes dialog takes the request, so it never reaches the probe.
    terminal.setDirty(true)
    await requestWindowClose()
    expect(settle).toHaveLength(1)

    terminal.cancelUnsavedChangesDialog()

    await act(async () => {
      settle[0]!(observedIdleInspection())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      confirmWindowClose,
      'a probe from a close the user cancelled at the unsaved-changes dialog must not close the window'
    ).not.toHaveBeenCalled()
  })

  it('does not close the window on a probe outstanding when a duplicate request was ignored', async () => {
    const terminal = installTerminalShapedHandler()
    const settle = installDeferredInspections()

    await requestWindowClose()
    terminal.setDirty(true)
    await requestWindowClose()
    // Terminal drops a third request while a deferred one is pending; the user has
    // still asked again, and the first attempt's probe is still stale.
    await requestWindowClose()
    terminal.cancelUnsavedChangesDialog()

    await act(async () => {
      settle[0]!(observedIdleInspection())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('still closes the window when nothing superseded the request', async () => {
    // Polarity control: the fence must not swallow the ordinary close.
    setWindowCloseRequestHandler(({ isQuitting }) => proceed!(isQuitting))
    const settle = installDeferredInspections()

    await requestWindowClose()
    await act(async () => {
      settle[0]!(observedIdleInspection())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })
})
