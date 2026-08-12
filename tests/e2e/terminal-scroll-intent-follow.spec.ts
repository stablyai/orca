import type { Page } from '@stablyai/playwright-test'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  sendToTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { waitForTerminalPtyDataInjector } from './helpers/terminal-pty-injection'

const STREAMING_FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/streaming-scrollback-fixture.cjs'
)
// Past the scroll-intent settle window (80ms) so a phantom pin has had every
// chance to latch before phase-2 output arrives.
const INTENT_SETTLE_WAIT_MS = 250

type ViewportProbe = {
  baseY: number
  viewportY: number
  containsMarker: boolean
}

async function probeActiveViewport(page: Page, marker: string): Promise<ViewportProbe | null> {
  return page.evaluate((markerText) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane?.terminal) {
      return null
    }
    const buffer = pane.terminal.buffer.active
    let containsMarker = false
    for (let line = buffer.baseY + pane.terminal.rows - 1; line >= 0; line -= 1) {
      const text = buffer.getLine(line)?.translateToString(true) ?? ''
      if (text.includes(markerText)) {
        containsMarker = true
        break
      }
    }
    return {
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      containsMarker
    }
  }, marker)
}

async function waitForMarkerAtBottom(page: Page, marker: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const probe = await probeActiveViewport(page, marker)
        return Boolean(probe && probe.containsMarker && probe.viewportY === probe.baseY)
      },
      {
        timeout: 30_000,
        message: `terminal did not reach "${marker}" with the viewport following the bottom`
      }
    )
    .toBe(true)
}

async function dispatchSubRowWheelUp(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane?.terminal.element) {
      throw new Error('Active terminal pane unavailable')
    }
    pane.terminal.element.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaY: -2
      })
    )
  })
}

async function dispatchRealWheel(page: Page, deltaY: number): Promise<void> {
  const point = await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane?.terminal.element) {
      throw new Error('Active terminal pane unavailable')
    }
    const screen = pane.terminal.element.querySelector<HTMLElement>('.xterm-screen')
    if (!screen) {
      throw new Error('Active terminal screen unavailable')
    }
    const rect = screen.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + Math.min(rect.height - 1, 40)
    }
  })
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(0, deltaY)
}

async function dispatchPlainHomeKeydown(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane?.terminal.element) {
      throw new Error('Active terminal pane unavailable')
    }
    const textarea =
      pane.terminal.element.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (!textarea) {
      throw new Error('xterm helper textarea unavailable')
    }
    textarea.focus()
    // Plain Home is delivered to the PTY app (readline start-of-line); it
    // never scrolls the xterm viewport.
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Home',
      code: 'Home'
    })
    // Why: xterm's key evaluator reads the legacy keyCode, which KeyboardEvent
    // constructors do not populate; without it no escape bytes reach the PTY.
    Object.defineProperty(event, 'keyCode', { configurable: true, value: 36 })
    Object.defineProperty(event, 'which', { configurable: true, value: 36 })
    textarea.dispatchEvent(event)
  })
}

async function injectQueuedWriteThenType(page: Page, paneKey: string): Promise<void> {
  await page.evaluate((targetPaneKey) => {
    const injectionTarget = window as Window & {
      __terminalPtyDataInjection?: { inject: (paneKey: string, data: string) => boolean }
    }
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('Active terminal pane unavailable')
    }
    const terminal = pane.terminal
    const originalWrite = terminal.write
    const holder: { write: { data: string; callback?: () => void } | null } = { write: null }
    terminal.write = ((data: string, callback?: () => void) => {
      holder.write = { data, callback }
    }) as typeof terminal.write
    try {
      const payload = '\x1b[?2026h\r\x1b[2KWorking in-flight\x1b[?2026l'
      if (!injectionTarget.__terminalPtyDataInjection?.inject(targetPaneKey, payload)) {
        throw new Error('PTY injector unavailable')
      }
      const textarea = pane.container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      if (!textarea) {
        throw new Error('xterm helper textarea unavailable')
      }
      textarea.focus()
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'x',
        code: 'KeyX'
      })
      Object.defineProperty(event, 'keyCode', { configurable: true, value: 88 })
      Object.defineProperty(event, 'which', { configurable: true, value: 88 })
      textarea.dispatchEvent(event)
    } finally {
      terminal.write = originalWrite
    }
    const heldWrite = holder.write
    if (!heldWrite) {
      throw new Error('Foreground terminal write was not captured')
    }
    originalWrite.call(terminal, heldWrite.data, heldWrite.callback)
  }, paneKey)
}

async function startStreamingFixturePhase1(page: Page): Promise<string> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const ptyId = await waitForActivePanePtyId(page)
  await execInTerminal(page, ptyId, `node "${STREAMING_FIXTURE_PATH}"`)
  await waitForMarkerAtBottom(page, 'STREAM_PHASE1_DONE')
  return ptyId
}

test.describe('terminal scroll intent keeps following output', () => {
  test('a sub-row wheel-up that never moves the viewport must not stop follow-output', async ({
    orcaPage
  }) => {
    const ptyId = await startStreamingFixturePhase1(orcaPage)

    // A -2px delta is far below one cell height: xterm scrolls zero rows, but
    // the intent listener still observes the trackpad-jitter-shaped wheel.
    await dispatchSubRowWheelUp(orcaPage)
    await orcaPage.waitForTimeout(INTENT_SETTLE_WAIT_MS)

    // Any byte releases the fixture's phase-2 stream.
    await sendToTerminal(orcaPage, ptyId, 'g')
    await waitForMarkerAtBottom(orcaPage, 'STREAM_PHASE2_DONE')
  })

  test('a plain Home keypress delivered to the app must not stop follow-output', async ({
    orcaPage
  }) => {
    await startStreamingFixturePhase1(orcaPage)

    // The Home escape sequence reaching the fixture's stdin doubles as the
    // phase-2 release, exactly like a user pressing Home mid-generation.
    await dispatchPlainHomeKeydown(orcaPage)
    await waitForMarkerAtBottom(orcaPage, 'STREAM_PHASE2_DONE')
  })

  test('a real wheel pin stays fixed while visible output streams', async ({ orcaPage }) => {
    const ptyId = await startStreamingFixturePhase1(orcaPage)

    await dispatchRealWheel(orcaPage, -240)
    await expect
      .poll(async () => {
        const probe = await probeActiveViewport(orcaPage, 'STREAM_PHASE1_DONE')
        return probe ? probe.baseY - probe.viewportY : 0
      })
      .toBeGreaterThan(1)
    const pinned = await probeActiveViewport(orcaPage, 'STREAM_PHASE1_DONE')
    if (!pinned) {
      throw new Error('terminal viewport unavailable after wheel pin')
    }

    await sendToTerminal(orcaPage, ptyId, 'g')
    await expect
      .poll(
        async () => {
          const probe = await probeActiveViewport(orcaPage, 'STREAM_PHASE2_DONE')
          return Boolean(probe && probe.containsMarker && probe.viewportY === pinned.viewportY)
        },
        { timeout: 30_000, message: 'visible streaming output moved the wheel-pinned viewport' }
      )
      .toBe(true)
  })

  test('typing after a pinned write is queued resumes follow-output', async ({ orcaPage }) => {
    await startStreamingFixturePhase1(orcaPage)
    const { paneKey } = await waitForActivePaneHookDescriptor(orcaPage)
    await waitForTerminalPtyDataInjector(orcaPage, paneKey)

    await dispatchRealWheel(orcaPage, -320)
    await expect
      .poll(async () => {
        const probe = await probeActiveViewport(orcaPage, 'STREAM_PHASE1_DONE')
        return probe ? probe.baseY - probe.viewportY : 0
      })
      .toBeGreaterThan(2)

    // Hold the xterm write call so typing deterministically lands between the
    // old per-write intent capture and its completion-time enforcement from #8625.
    await injectQueuedWriteThenType(orcaPage, paneKey)
    await expect
      .poll(
        async () => {
          const probe = await probeActiveViewport(orcaPage, 'STREAM_PHASE1_DONE')
          return probe ? probe.baseY - probe.viewportY : Number.NaN
        },
        { timeout: 5_000, intervals: [25] }
      )
      .toBe(0)
  })
})
