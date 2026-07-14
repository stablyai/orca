import type { Page } from '@stablyai/playwright-test'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

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
    const screen = pane.terminal.element.querySelector<HTMLElement>('.xterm-screen')
    if (!screen) {
      throw new Error('Active terminal screen unavailable')
    }
    const rect = screen.getBoundingClientRect()
    // A -2px delta is far below one cell height: xterm scrolls zero rows, the
    // viewport stays at the bottom, but the wheel listener still observes an
    // upward wheel — the phantom-pin shape from trackpad jitter.
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + Math.min(rect.height - 1, 40),
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: -2
    })
    pane.terminal.element.dispatchEvent(event)
  })
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
})
