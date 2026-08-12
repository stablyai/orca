import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  switchToOtherWorktree,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  sendToTerminal,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { waitForTabParked } from './helpers/terminal-hidden-parking'

// Field bug (v1.4.144-rc.4): switching back to a workspace whose Codex TUI kept
// streaming while hidden shows a mostly-blank terminal — live block (input box)
// missing, viewport stranded mid-buffer — until a manual resize (Cmd+L) forces
// SIGWINCH and Codex repaints. The alt-screen park/reveal specs never caught it
// because Codex runs in INLINE mode and keeps writing across the reveal.
//
// These tests drive a codex-shaped inline TUI that never stops writing, hide
// the pane across the gate/park boundaries, reveal, and require convergence to
// the live frame WITHOUT any resize:
//  1. viewport anchored at the buffer bottom (not stranded mid-scrollback),
//  2. a recent CODEX_FRAME + the input-box row visible in the on-screen rows,
//  3. still following (frame number advances on screen) after convergence,
//  4. xterm grid == fit proposal == PTY-applied size (no stale 80x24 PTY).

const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500

test.use({
  orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) }
})

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'codex-inline-live-block-fixture.cjs')
const FRAME_RE = /CODEX_FRAME_(\d+)/g
const INPUT_BOX_MARKER = 'INPUT_BOX_READY_MARKER'
// The fixture ticks every 60ms; allow a generous parse/delivery lag while
// still rejecting a frozen frame from before the hide.
const MAX_VISIBLE_FRAME_LAG = 50

type RevealProbe = {
  ptyId: string | null
  viewportY: number
  baseY: number
  cols: number
  rows: number
  proposed: { cols: number; rows: number } | null
  appliedPtySize: { cols: number; rows: number } | null
  screenRows: string[]
}

function latestFrame(text: string): number {
  let latest = -1
  for (const match of text.matchAll(FRAME_RE)) {
    latest = Math.max(latest, Number(match[1]))
  }
  return latest
}

function heartbeatFrame(heartbeatPath: string): number {
  try {
    return Number(readFileSync(heartbeatPath, 'utf8').trim())
  } catch {
    return -1
  }
}

// Why the pane resolves by tab (not a captured ptyId): agent quick-launch
// startup can respawn the tab's PTY after the initial bind, so a ptyId
// captured at mount can go stale while the pane itself stays healthy.
async function probeRevealedPane(page: Page, tabId: string): Promise<RevealProbe | null> {
  return page.evaluate(
    async ({ tabId }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!pane) {
        return null
      }
      const ptyId = pane.container.dataset.ptyId ?? null
      const terminal = pane.terminal
      const buffer = terminal.buffer.active
      const screenRows: string[] = []
      for (let i = 0; i < terminal.rows; i += 1) {
        const line = buffer.getLine(buffer.viewportY + i)
        screenRows.push(line ? line.translateToString(true) : '')
      }
      let proposed: { cols: number; rows: number } | null = null
      try {
        proposed = pane.fitAddon.proposeDimensions() ?? null
      } catch {
        proposed = null
      }
      let appliedPtySize: { cols: number; rows: number } | null = null
      try {
        appliedPtySize = ptyId ? ((await window.api.pty.getSize(ptyId)) ?? null) : null
      } catch {
        appliedPtySize = null
      }
      return {
        ptyId,
        viewportY: buffer.viewportY,
        baseY: buffer.baseY,
        cols: terminal.cols,
        rows: terminal.rows,
        proposed,
        appliedPtySize,
        screenRows
      }
    },
    { tabId }
  )
}

// Painted-pixels check: buffer-level assertions cannot see paint-layer bugs
// (atlas wipe races, paused-RenderService swallowed refreshes), where xterm's
// buffer is perfect but the canvas shows blank/stale cells until a resize.
// Measure the "ink" (non-background pixel ratio) of a horizontal band of the
// pane screenshot; the fixture's live block guarantees box-drawing + text ink
// in its bottom rows whenever paint is healthy.
function measureBandInkRatio(
  screenshot: Buffer,
  bandTopFraction: number,
  bandBottomFraction: number
): number {
  const png = PNG.sync.read(screenshot)
  const colorCounts = new Map<number, number>()
  for (let offset = 0; offset < png.data.length; offset += 32) {
    const key =
      ((png.data[offset] ?? 0) << 16) |
      ((png.data[offset + 1] ?? 0) << 8) |
      (png.data[offset + 2] ?? 0)
    colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1)
  }
  let backgroundKey = 0
  let backgroundCount = -1
  for (const [key, count] of colorCounts) {
    if (count > backgroundCount) {
      backgroundKey = key
      backgroundCount = count
    }
  }
  const backgroundRed = (backgroundKey >> 16) & 0xff
  const backgroundGreen = (backgroundKey >> 8) & 0xff
  const backgroundBlue = backgroundKey & 0xff
  const yStart = Math.max(0, Math.floor(png.height * bandTopFraction))
  const yEnd = Math.min(png.height, Math.ceil(png.height * bandBottomFraction))
  let ink = 0
  let total = 0
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4
      const diff =
        Math.abs((png.data[offset] ?? 0) - backgroundRed) +
        Math.abs((png.data[offset + 1] ?? 0) - backgroundGreen) +
        Math.abs((png.data[offset + 2] ?? 0) - backgroundBlue)
      total += 1
      if (diff > 48) {
        ink += 1
      }
    }
  }
  return total > 0 ? ink / total : 0
}

async function forceWebglOnActiveTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state?.settings) {
      throw new Error('Store unavailable')
    }
    window.__store?.setState({
      settings: {
        ...state.settings,
        terminalGpuAcceleration: 'on'
      }
    })
    const worktreeId = state.activeWorktreeId
    const tabId =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    window.__paneManagers?.get(tabId ?? '')?.setTerminalGpuAcceleration?.('on')
  })
}

async function paneClipRect(
  page: Page,
  tabId: string
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      return null
    }
    const rect = pane.container.getBoundingClientRect()
    if (rect.width < 10 || rect.height < 10) {
      return null
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }, tabId)
}

async function isTerminalPaneMounted(page: Page, tabId: string): Promise<boolean> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    return Boolean(manager && manager.getPanes().length > 0)
  }, tabId)
}

function describeProbe(probe: RevealProbe | null): string {
  if (!probe) {
    return 'pane not mounted'
  }
  return JSON.stringify(
    {
      viewportY: probe.viewportY,
      baseY: probe.baseY,
      cols: probe.cols,
      rows: probe.rows,
      proposed: probe.proposed,
      appliedPtySize: probe.appliedPtySize,
      screenTail: probe.screenRows.slice(-10)
    },
    null,
    1
  )
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((targetTabId) => {
    const store = window.__store
    if (!store) {
      throw new Error('activateTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    state.setActiveTabType('terminal')
    state.setActiveTab(targetTabId)
  }, tabId)
  await expect
    .poll(() => getActiveTabId(page), {
      timeout: 5_000,
      message: `terminal tab ${tabId} did not become active`
    })
    .toBe(tabId)
}

async function createActiveTerminalTab(page: Page, worktreeId: string): Promise<string> {
  const tabId = await page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('createActiveTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    const tab = state.createTab(worktreeId, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal')
    return tab.id
  }, worktreeId)
  await expect
    .poll(() => getActiveTabId(page), {
      timeout: 5_000,
      message: 'newly created terminal tab did not become active'
    })
    .toBe(tabId)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneIdentitySnapshot(page, 1)
  return tabId
}

type StreamingTabSetup = {
  worktreeId: string
  tabId: string
  ptyId: string
  heartbeatPath: string
  stop: () => Promise<void>
}

// Why a fresh tab per test: the app instance is shared across this file's
// serial tests, so reusing the initial tab would type the launch command into
// the previous test's still-running fixture instead of a shell prompt.
//
// Why agent-marked: a real Codex tab carries launchAgent/telemetry, which
// flips the reveal into the live-agent reattach branches (mode-preserving
// resets, hidden startup query grammar, post-replay focus-in) — the branches
// the field bug lives behind.
async function startStreamingInlineTui(
  page: Page,
  testInfo: TestInfo,
  options: { historyLinesPerSecond?: number; seedLines?: number } = {}
): Promise<StreamingTabSetup> {
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const heartbeatPath = testInfo.outputPath(`codex-inline-heartbeat-${Date.now()}.txt`)
  const command = `node ${JSON.stringify(FIXTURE_PATH)} ${JSON.stringify(heartbeatPath)} ${options.historyLinesPerSecond ?? 4} ${options.seedLines ?? 120}`
  const tabId = await page.evaluate(
    ({ worktreeId, command }) => {
      const store = window.__store
      if (!store) {
        throw new Error('startStreamingInlineTui: window.__store is unavailable')
      }
      const state = store.getState()
      const tab = state.createTab(worktreeId, undefined, undefined, { launchAgent: 'codex' })
      state.queueTabStartupCommand(tab.id, {
        command,
        launchAgent: 'codex',
        telemetry: {
          agent_kind: 'codex',
          launch_source: 'tab_bar_quick_launch',
          request_kind: 'new'
        }
      })
      state.setActiveTab(tab.id)
      state.setActiveTabType('terminal')
      return tab.id
    },
    { worktreeId, command }
  )
  await expect
    .poll(() => getActiveTabId(page), {
      timeout: 5_000,
      message: 'agent-marked streaming tab did not become active'
    })
    .toBe(tabId)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneIdentitySnapshot(page, 1)
  // WebGL on: the paint-layer seams under test (atlas wipes, render-pause
  // release) only exist on the GPU renderer path.
  await forceWebglOnActiveTab(page)
  await expect
    .poll(
      async () => latestFrame((await probeRevealedPane(page, tabId))?.screenRows.join('\n') ?? ''),
      {
        timeout: 20_000,
        message: 'inline TUI fixture did not start streaming in the visible pane'
      }
    )
    .toBeGreaterThan(5)
  // Capture the PTY id only after the fixture streams: agent quick-launch can
  // respawn the tab's PTY when the startup command binds.
  const ptyId = (await probeRevealedPane(page, tabId))?.ptyId
  if (!ptyId) {
    throw new Error('streaming tab did not bind a PTY')
  }
  return {
    worktreeId,
    tabId,
    ptyId,
    heartbeatPath,
    stop: async () => {
      // Ctrl+C so the shared app does not accumulate streaming fixtures.
      await sendToTerminal(page, ptyId, '\x03').catch(() => {})
      await page.waitForTimeout(100)
    }
  }
}

async function assertRevealConvergence(
  page: Page,
  testInfo: TestInfo,
  setup: StreamingTabSetup,
  label: string
): Promise<void> {
  const { tabId, heartbeatPath } = setup

  // Premise: the fixture kept streaming while hidden.
  const heartbeatAtReveal = heartbeatFrame(heartbeatPath)
  expect(heartbeatAtReveal, 'fixture stopped streaming while hidden').toBeGreaterThan(5)

  let lastProbe: RevealProbe | null = null
  await expect
    .poll(
      async () => {
        lastProbe = await probeRevealedPane(page, tabId)
        if (!lastProbe) {
          return 'pane-not-mounted'
        }
        if (lastProbe.viewportY !== lastProbe.baseY) {
          return `viewport-stranded viewportY=${lastProbe.viewportY} baseY=${lastProbe.baseY}`
        }
        const screen = lastProbe.screenRows.join('\n')
        if (!screen.includes(INPUT_BOX_MARKER)) {
          return 'input-box-row-missing'
        }
        const visibleFrame = latestFrame(screen)
        const liveFrame = heartbeatFrame(heartbeatPath)
        if (visibleFrame < 0 || liveFrame - visibleFrame > MAX_VISIBLE_FRAME_LAG) {
          return `stale-frame visible=${visibleFrame} live=${liveFrame}`
        }
        return 'converged'
      },
      {
        timeout: 20_000,
        message: `${label}: revealed pane did not converge to the live inline TUI without a resize`
      }
    )
    .toBe('converged')
    .catch(async (error) => {
      testInfo.annotations.push({
        type: `${label}-divergence-probe`,
        description: describeProbe(lastProbe)
      })
      const screenshotPath = testInfo.outputPath(`${label}-divergence.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true })
      await testInfo.attach(`${label}-divergence.png`, {
        path: screenshotPath,
        contentType: 'image/png'
      })
      throw error
    })

  // Still following: the on-screen frame must keep advancing after convergence
  // with the viewport still pinned to the bottom.
  const convergedFrame = latestFrame(
    (await probeRevealedPane(page, tabId))?.screenRows.join('\n') ?? ''
  )
  await expect
    .poll(
      async () => {
        const probe = await probeRevealedPane(page, tabId)
        if (!probe || probe.viewportY !== probe.baseY) {
          return -1
        }
        return latestFrame(probe.screenRows.join('\n'))
      },
      {
        timeout: 10_000,
        message: `${label}: revealed pane stopped following live output after convergence`
      }
    )
    .toBeGreaterThan(convergedFrame)

  // Geometry: no stale-80x24 leg — xterm grid, fit proposal, and PTY-applied
  // size must agree without any manual resize.
  const probe = await probeRevealedPane(page, tabId)
  expect(probe, `${label}: pane disappeared after convergence`).not.toBeNull()
  expect(probe!.proposed, `${label}: fit proposal diverges: ${describeProbe(probe)}`).toEqual({
    cols: probe!.cols,
    rows: probe!.rows
  })
  expect(
    probe!.appliedPtySize,
    `${label}: PTY applied-size read unavailable: ${describeProbe(probe)}`
  ).not.toBeNull()
  expect(
    probe!.appliedPtySize,
    `${label}: PTY applied size diverges: ${describeProbe(probe)}`
  ).toEqual({ cols: probe!.cols, rows: probe!.rows })

  // Painted pixels: the live block guarantees box-drawing + text ink in the
  // pane's bottom rows. Blank band + healthy buffer = paint-layer divergence
  // (atlas wipe race / paused RenderService) — the class a resize also heals.
  const clip = await paneClipRect(page, tabId)
  expect(clip, `${label}: pane rect unavailable for paint check`).not.toBeNull()
  const bandTop = Math.max(0, 1 - 8 / (probe!.rows || 24))
  await expect
    .poll(
      async () => {
        const shot = await page.screenshot({ clip: clip! })
        return measureBandInkRatio(shot, bandTop, 1)
      },
      {
        timeout: 10_000,
        message: `${label}: live block rows painted blank while the buffer holds content (paint-layer divergence)`
      }
    )
    .toBeGreaterThan(0.005)
}

async function resizeAppWindow(
  electronApp: ElectronApplication,
  deltaWidth: number,
  deltaHeight: number
): Promise<void> {
  // Why the retry: the main-process utility context Playwright evaluates in
  // can be transiently recycled ("Execution context was destroyed") right
  // after heavy renderer work like a worktree switch; the resize itself is
  // idempotent-safe to attempt again.
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await electronApp.evaluate(
        ({ BrowserWindow }, { deltaWidth, deltaHeight }) => {
          const window = BrowserWindow.getAllWindows()[0]
          if (!window) {
            throw new Error('No Electron window')
          }
          const [width, height] = window.getSize()
          window.setSize(width + deltaWidth, height + deltaHeight)
        },
        { deltaWidth, deltaHeight }
      )
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw lastError
}

// CPU throttling around the reveal action simulates the loaded-machine
// conditions the field failures occur under, deterministically.
async function withCpuThrottle<T>(page: Page, rate: number, run: () => Promise<T>): Promise<T> {
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Emulation.setCPUThrottlingRate', { rate })
    return await run()
  } finally {
    await session.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {})
    await session.detach().catch(() => {})
  }
}

async function streamWhileParked(setup: StreamingTabSetup, minFrames: number): Promise<void> {
  const heartbeatBefore = heartbeatFrame(setup.heartbeatPath)
  await expect
    .poll(() => heartbeatFrame(setup.heartbeatPath), {
      timeout: 60_000,
      message: 'fixture did not keep streaming while hidden/parked'
    })
    .toBeGreaterThan(heartbeatBefore + minFrames)
}

test.describe('Inline TUI reveal convergence', () => {
  test('hidden-but-mounted tab reveal converges while the inline TUI streams', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(120_000)
    const setup = await startStreamingInlineTui(orcaPage, testInfo)
    try {
      // Tab B hides tab A. Reveal quickly — inside the cold-park delay — so
      // the reveal exercises the hidden-delivery-gate restore, not parking.
      const tabBId = await createActiveTerminalTab(orcaPage, setup.worktreeId)
      expect(tabBId).not.toBe(setup.tabId)
      await orcaPage.waitForTimeout(Math.max(50, Math.min(PARKING_DELAY_MS / 2, 200)))
      expect(
        await isTerminalPaneMounted(orcaPage, setup.tabId),
        'hidden-mounted scenario cold-parked before reveal'
      ).toBe(true)

      await activateTerminalTab(orcaPage, setup.tabId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await assertRevealConvergence(orcaPage, testInfo, setup, 'hidden-mounted-reveal')
    } finally {
      await setup.stop()
    }
  })

  test('worktree switch reveal converges after a hidden-time window resize', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    test.setTimeout(120_000)
    const setup = await startStreamingInlineTui(orcaPage, testInfo, {
      historyLinesPerSecond: 20
    })
    try {
      // Surface hide: switch to ANOTHER WORKTREE (the field action), which
      // suspends rendering and takes the heavy resume path on return.
      const otherWorktreeId = await switchToOtherWorktree(orcaPage, setup.worktreeId)
      test.skip(!otherWorktreeId, 'test session has a single worktree; cannot surface-hide')

      // Change the window size while the pane is display:none (0x0 container,
      // no fit runs). This is what Cmd+L's sidebar toggle does to every hidden
      // workspace: at reveal the pane grid differs from the daemon snapshot's.
      await resizeAppWindow(electronApp, -180, -120)
      await orcaPage.waitForTimeout(2_500)

      await switchToWorktree(orcaPage, setup.worktreeId)
      await activateTerminalTab(orcaPage, setup.tabId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await assertRevealConvergence(orcaPage, testInfo, setup, 'worktree-resize-reveal')
    } finally {
      await resizeAppWindow(electronApp, 180, 120).catch(() => {})
      await setup.stop()
    }
  })

  test('parked tab reveal converges across repeated cycles while the inline TUI streams heavily', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(480_000)
    const setup = await startStreamingInlineTui(orcaPage, testInfo, {
      historyLinesPerSecond: 30,
      seedLines: 8_000
    })
    try {
      // Tab B hides tab A; the decoy then hides tab B so B (most recently
      // hidden) takes the #8262 last-active exemption and tab A cold-parks.
      const tabBId = await createActiveTerminalTab(orcaPage, setup.worktreeId)
      const decoyTabId = await createActiveTerminalTab(orcaPage, setup.worktreeId)

      // The field failure is periodic, not every reveal — cycle the park →
      // stream → reveal boundary and require convergence every time.
      const CYCLES = 6
      for (let cycle = 0; cycle < CYCLES; cycle += 1) {
        if (cycle > 0) {
          await activateTerminalTab(orcaPage, tabBId)
          await activateTerminalTab(orcaPage, decoyTabId)
        }
        await waitForTabParked(orcaPage, setup.tabId, { parkDelayMs: PARKING_DELAY_MS })

        // Accumulate a field-sized backlog against the parked (unmounted)
        // view so the reveal replay races the live stream, like a real Codex.
        await streamWhileParked(setup, 100)

        // Reveal under CPU throttle: a long replay parse + throttled frames is
        // the loaded-machine window where the corrective fit and follow-anchor
        // lose their races in the field.
        await withCpuThrottle(orcaPage, 6, async () => {
          await activateTerminalTab(orcaPage, setup.tabId)
          await waitForActiveTerminalManager(orcaPage, 30_000)
          await orcaPage.waitForTimeout(3_000)
        })
        const revealed = await waitForPaneIdentitySnapshot(orcaPage, 1)
        expect(revealed.panes[0]?.ptyId).toBe(setup.ptyId)
        await assertRevealConvergence(orcaPage, testInfo, setup, `parked-heavy-reveal-c${cycle}`)
      }
    } finally {
      await setup.stop()
    }
  })

  test('rapid tab hide/reveal flapping never wedges delivery for the streaming inline TUI', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(150_000)
    const setup = await startStreamingInlineTui(orcaPage, testInfo, {
      historyLinesPerSecond: 10
    })
    try {
      const tabBId = await createActiveTerminalTab(orcaPage, setup.worktreeId)
      // Rapid flapping drives the hidden-delivery gate claim/release IPC and
      // the hidden-output restore against each other at varied phases — the
      // desync class behind "bytes dropped on a visible pane" field freezes.
      for (let flap = 0; flap < 12; flap += 1) {
        await activateTerminalTab(orcaPage, tabBId)
        await orcaPage.waitForTimeout(50 + (flap % 3) * 120)
        await activateTerminalTab(orcaPage, setup.tabId)
        await orcaPage.waitForTimeout(50 + ((flap * 7) % 5) * 90)
      }
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await assertRevealConvergence(orcaPage, testInfo, setup, 'tab-flapping-reveal')
    } finally {
      await setup.stop()
    }
  })

  test('rapid worktree switch flapping never wedges delivery for the streaming inline TUI', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(150_000)
    const setup = await startStreamingInlineTui(orcaPage, testInfo, {
      historyLinesPerSecond: 10,
      seedLines: 4_000
    })
    try {
      const otherWorktreeId = await switchToOtherWorktree(orcaPage, setup.worktreeId)
      test.skip(!otherWorktreeId, 'test session has a single worktree; cannot surface-flap')
      // Surface-level flapping (the field action): suspend/resume rendering +
      // heavy resume path race the gate resync and reveal repaint each cycle,
      // under CPU throttle to widen the race windows like a loaded machine.
      await withCpuThrottle(orcaPage, 6, async () => {
        for (let flap = 0; flap < 10; flap += 1) {
          await switchToWorktree(orcaPage, otherWorktreeId!)
          await orcaPage.waitForTimeout(60 + (flap % 4) * 110)
          await switchToWorktree(orcaPage, setup.worktreeId)
          await orcaPage.waitForTimeout(60 + ((flap * 5) % 4) * 130)
        }
      })
      await activateTerminalTab(orcaPage, setup.tabId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await assertRevealConvergence(orcaPage, testInfo, setup, 'worktree-flapping-reveal')
    } finally {
      await setup.stop()
    }
  })

  test('parked tab reveal converges after a parked-time window resize', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    test.setTimeout(180_000)
    const setup = await startStreamingInlineTui(orcaPage, testInfo, {
      historyLinesPerSecond: 20
    })
    try {
      await createActiveTerminalTab(orcaPage, setup.worktreeId)
      await createActiveTerminalTab(orcaPage, setup.worktreeId)
      await waitForTabParked(orcaPage, setup.tabId, { parkDelayMs: PARKING_DELAY_MS })

      // Resize while parked: the remount measures a grid that matches neither
      // the pre-park xterm nor the daemon snapshot — maximum dimension churn.
      await resizeAppWindow(electronApp, -180, -120)
      await streamWhileParked(setup, 100)

      await activateTerminalTab(orcaPage, setup.tabId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      const revealed = await waitForPaneIdentitySnapshot(orcaPage, 1)
      expect(revealed.panes[0]?.ptyId).toBe(setup.ptyId)
      await assertRevealConvergence(orcaPage, testInfo, setup, 'parked-resize-reveal')
    } finally {
      await resizeAppWindow(electronApp, 180, 120).catch(() => {})
      await setup.stop()
    }
  })
})
