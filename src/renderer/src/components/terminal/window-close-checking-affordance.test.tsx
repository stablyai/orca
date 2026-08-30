// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPtyProcessInspectionWireResult } from '../../../../shared/pty-process-inspection-evidence'
import type { AppState } from '@/store/types'

/**
 * The four-second probe deadline is the point of the window-close guard, so the wait
 * cannot be shortened — what it was missing is any sign it is happening. These assert
 * the affordance on the rendered dialog: which line is visible, whether the confirm is
 * disabled, and where focus sits. The geometry half of "must not jump" needs a real
 * layout engine and is proven under CDP, not here; what is pinned here is the mechanism
 * that makes it hold — both lines rendered into one grid cell in both phases.
 */

const { getStateMock } = vi.hoisted(() => ({ getStateMock: vi.fn() }))

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))
vi.mock('@/lib/shutdown-checkpoint-failure-toast', () => ({
  showShutdownCheckpointFailureToast: vi.fn()
}))

import {
  dispatchWindowCloseRequest,
  setWindowCloseRequestHandler
} from '../window-close-request-coordinator'
import {
  useWindowCloseRunningProcessPrompt,
  WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS
} from './window-close-running-process-prompt'

const PTY_ID = 'pty-local-1'
const WORKTREE_ID = 'repo-local::/home/dev/work'
const CHECKING = 'Checking terminals for running processes…'
const WARNING = 'There are terminals with running processes.'

function storeState(): unknown {
  return {
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-1' }] },
    ptyIdsByTabId: { 'tab-1': [PTY_ID] },
    repos: [{ id: 'repo-local', connectionId: null }] as unknown as AppState['repos'],
    worktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: []
  }
}

function liveInspection(): unknown {
  return buildPtyProcessInspectionWireResult(
    { verdict: 'observed', processName: 'codex' },
    { verdict: 'live' }
  )
}

function idleInspection(): unknown {
  return buildPtyProcessInspectionWireResult(
    { verdict: 'observed', processName: 'zsh' },
    { verdict: 'exited' }
  )
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let confirmWindowClose: ReturnType<typeof vi.fn>
let proceed: ((isQuitting: boolean) => void) | null = null
/** Resolves the in-flight inspection, so a probe can be held past the delay on purpose. */
let settleInspection: ((value: unknown) => void) | null = null

function Harness(): React.ReactNode {
  const prompt = useWindowCloseRunningProcessPrompt()
  proceed = prompt.proceedToNativeWindowClose
  return prompt.windowCloseDialog
}

function installDeferredInspectProcess(): void {
  ;(window as unknown as { api: unknown }).api = {
    pty: {
      inspectProcess: vi.fn(
        () =>
          new Promise((resolve) => {
            settleInspection = resolve
          })
      ),
      hasChildProcesses: vi.fn(async () => true)
    },
    ui: { confirmWindowClose }
  }
}

/** The visible line, by class rather than computed style: happy-dom loads no Tailwind. */
function lineFor(text: string): HTMLElement | null {
  return (
    ([...document.querySelectorAll('span')].find((span) => span.textContent?.includes(text)) as
      | HTMLElement
      | undefined) ?? null
  )
}

function isVisible(text: string): boolean {
  const line = lineFor(text)
  return line !== null && !line.classList.contains('invisible')
}

function confirmButton(): HTMLButtonElement | null {
  return (
    ([...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Close'
    ) as HTMLButtonElement | undefined) ?? null
  )
}

function cancelButton(): HTMLButtonElement | null {
  return (
    ([...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Cancel'
    ) as HTMLButtonElement | undefined) ?? null
  )
}

function dialogIsOpen(): boolean {
  return document.querySelector('[data-slot="dialog-content"]') !== null
}

async function advancePast(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
  })
}

async function settleWith(value: unknown): Promise<void> {
  await act(async () => {
    settleInspection!(value)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function startWindowClose(): Promise<void> {
  await act(async () => {
    proceed!(false)
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  confirmWindowClose = vi.fn()
  settleInspection = null
  getStateMock.mockReturnValue(storeState())
  installDeferredInspectProcess()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<Harness />)
  })
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('window close pending affordance', () => {
  it('says nothing at all until the probe outruns the delay', async () => {
    await startWindowClose()

    await advancePast(WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS - 1)

    expect(dialogIsOpen()).toBe(false)
  })

  it('raises a checking state once the probe outruns the delay', async () => {
    await startWindowClose()

    await advancePast(WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS)

    expect(dialogIsOpen()).toBe(true)
    expect(isVisible(CHECKING)).toBe(true)
    expect(isVisible(WARNING)).toBe(false)
    expect(document.querySelector('svg.animate-spin')).not.toBeNull()
    expect(confirmButton()?.disabled).toBe(true)
    // Why cancel stays live: the complaint was an unresponsive window, and a
    // pending state the user cannot back out of is the same complaint.
    expect(cancelButton()?.disabled).toBe(false)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('does not raise the checking state for an attempt a later request superseded', async () => {
    // The deferral is armed per attempt, and the requests that supersede one need
    // never reach the hook: Terminal hands a close with dirty editors to the
    // unsaved-changes dialog and returns, so nothing here can cancel this timer.
    setWindowCloseRequestHandler(({ isQuitting }) => proceed!(isQuitting))
    await act(async () => {
      await dispatchWindowCloseRequest({ isQuitting: false })
    })
    setWindowCloseRequestHandler(() => {})
    await act(async () => {
      await dispatchWindowCloseRequest({ isQuitting: false })
    })

    await advancePast(WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS)

    expect(
      dialogIsOpen(),
      'a pending state for a close the user has moved past is a dialog they never asked for'
    ).toBe(false)
  })

  it('still raises it for the attempt that is current, driven the same way', async () => {
    // Polarity control: the fence must not swallow the affordance itself.
    setWindowCloseRequestHandler(({ isQuitting }) => proceed!(isQuitting))
    await act(async () => {
      await dispatchWindowCloseRequest({ isQuitting: false })
    })

    await advancePast(WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS)

    expect(dialogIsOpen()).toBe(true)
    expect(isVisible(CHECKING)).toBe(true)
  })

  it('never flashes the checking state for a probe that answers warm', async () => {
    await startWindowClose()

    await settleWith(liveInspection())

    expect(isVisible(WARNING)).toBe(true)
    expect(isVisible(CHECKING)).toBe(false)
    expect(confirmButton()?.disabled).toBe(false)

    // The timer must be dead, not merely beaten: a live one would raise the
    // checking line over an answer the user is already reading.
    await advancePast(WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS * 2)
    expect(isVisible(CHECKING)).toBe(false)
    expect(isVisible(WARNING)).toBe(true)
  })

  it('leaves no dialog behind after a warm close', async () => {
    await startWindowClose()

    await settleWith(idleInspection())

    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
    expect(dialogIsOpen()).toBe(false)

    // A timer left armed here would pop a checking dialog onto a window that
    // has already been told to close.
    await advancePast(WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS * 2)
    expect(dialogIsOpen()).toBe(false)
  })

  it('keeps both lines mounted in one grid cell in both phases', async () => {
    await startWindowClose()
    await advancePast(WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS)

    const checkingPhase = [lineFor(CHECKING), lineFor(WARNING)]
    expect(checkingPhase.every((line) => line !== null)).toBe(true)

    await settleWith(liveInspection())

    const blockedPhase = [lineFor(CHECKING), lineFor(WARNING)]
    expect(blockedPhase.every((line) => line !== null)).toBe(true)
    // Same cell in both phases is what makes the box size for the taller line and
    // stops the prompt resizing the dialog when it replaces the checking line.
    for (const line of [...checkingPhase, ...blockedPhase]) {
      expect(line!.className).toContain('col-start-1')
      expect(line!.className).toContain('row-start-1')
    }
  })

  it('hands focus to the confirm once the answer replaces the checking line', async () => {
    await startWindowClose()
    await advancePast(WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS)
    expect(document.activeElement).not.toBe(confirmButton())

    await settleWith(liveInspection())

    expect(document.activeElement).toBe(confirmButton())
  })

  it('drops a probe the user cancelled from the checking state', async () => {
    await startWindowClose()
    await advancePast(WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS)

    await act(async () => {
      cancelButton()!.click()
      await Promise.resolve()
    })
    expect(dialogIsOpen()).toBe(false)

    await settleWith(liveInspection())

    // The answer belongs to a close the user has since called off.
    expect(dialogIsOpen()).toBe(false)
    expect(confirmWindowClose).not.toHaveBeenCalled()
  })

  it('does not arm the affordance for a quit that never probes', async () => {
    await act(async () => {
      proceed!(true)
      await Promise.resolve()
    })

    await advancePast(WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS * 2)

    expect(dialogIsOpen()).toBe(false)
    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })
  it('closes the window when the answer clears a checking state already on screen', async () => {
    await startWindowClose()
    await advancePast(WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS)
    expect(isVisible(CHECKING)).toBe(true)

    await settleWith(idleInspection())

    // A checking line left on screen would outlive the close it was reporting on.
    expect(dialogIsOpen()).toBe(false)
    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })

  it("disarms an earlier attempt's affordance when a later close never probes", async () => {
    await startWindowClose()

    await act(async () => {
      proceed!(true)
      await Promise.resolve()
    })
    await advancePast(WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS * 2)

    // The first attempt's timer must not raise a checking dialog over a window
    // the second attempt has already told to close.
    expect(dialogIsOpen()).toBe(false)
    expect(confirmWindowClose).toHaveBeenCalledTimes(1)
  })

  it('still focuses the confirm on the warm path that never showed a checking line', async () => {
    await startWindowClose()

    await settleWith(liveInspection())

    expect(isVisible(CHECKING)).toBe(false)
    expect(document.activeElement).toBe(confirmButton())
  })
  it('disarms the affordance when the window unmounts mid-probe', async () => {
    // Tracked by id rather than by timer count: React arms timers of its own, so a
    // count cannot say whose was released.
    const armTimer = vi.spyOn(globalThis, 'setTimeout')
    const releaseTimer = vi.spyOn(globalThis, 'clearTimeout')
    await startWindowClose()
    const armIndex = armTimer.mock.calls.findIndex(
      (call) => call[1] === WINDOW_CLOSE_CHECKING_AFFORDANCE_DELAY_MS
    )
    expect(armIndex).toBeGreaterThanOrEqual(0)
    const affordanceTimerId = armTimer.mock.results[armIndex]!.value

    act(() => {
      root!.unmount()
      root = null
    })

    // Asserted on the release and not on rendered output on purpose: a leaked timer
    // fires into a torn-down tree, which React 19 swallows silently.
    expect(releaseTimer).toHaveBeenCalledWith(affordanceTimerId)
  })
})
