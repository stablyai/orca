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

// v1.4.144-rc.4: streaming inline Codex revealed blank/stale until resize; alt-screen parking tests missed the inline path.
// Across gate/park boundaries require a bottom-anchored advancing live frame/input box and xterm/fit/applied-PTY size agreement without resize.

const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500

test.use({
  orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) }
})

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'codex-inline-live-block-fixture.cjs')
const FRAME_RE = /CODEX_FRAME_(\d+)/g
const INPUT_BOX_MARKER = 'INPUT_BOX_READY_MARKER'
// Allow delivery lag at 60ms ticks while rejecting a frozen pre-hide frame.
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

// Resolve by tab: agent quick-launch may respawn the PTY after initial bind, invalidating a captured ptyId.
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

// Check screenshot ink in the live block’s bottom band: healthy buffers can hide atlas-wipe or paused-RenderService paint failures.
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
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
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
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
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

// Use a fresh tab so serial tests cannot type into the prior streaming fixture.
// Agent-mark it to exercise live-agent reattach, mode-preserving reset, startup-query and post-replay-focus paths.
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
      state.setActiveTabType('terminal', window.__store?.getState().activeWorktreeId ?? null)
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
  // Require WebGL: atlas-wipe/render-pause seams exist only on the GPU path.
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
  // Capture PTY id after streaming starts because quick-launch can respawn it.
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
  // Retry idempotent resize when heavy renderer work transiently recycles main’s utility execution context.
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

// Throttle only reveal to widen loaded-machine race windows.
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
      // Reveal inside the cold-park delay to isolate hidden-delivery-gate restore.
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
      // Switch worktrees to exercise surface suspension and heavy resume, matching the field action.
      const otherWorktreeId = await switchToOtherWorktree(orcaPage, setup.worktreeId)
      test.skip(!otherWorktreeId, 'test session has a single worktree; cannot surface-hide')

      // Resize while display:none prevents fit, forcing revealed grid/daemon snapshot dimension disagreement as Cmd+L does.
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
      // Hide A with B, then B with a decoy so B takes #8262’s exemption and A cold-parks.
      const tabBId = await createActiveTerminalTab(orcaPage, setup.worktreeId)
      const decoyTabId = await createActiveTerminalTab(orcaPage, setup.worktreeId)

      // Repeat park/stream/reveal because the field failure is intermittent.
      const CYCLES = 6
      for (let cycle = 0; cycle < CYCLES; cycle += 1) {
        if (cycle > 0) {
          await activateTerminalTab(orcaPage, tabBId)
          await activateTerminalTab(orcaPage, decoyTabId)
        }
        await waitForTabParked(orcaPage, setup.tabId, { parkDelayMs: PARKING_DELAY_MS })

        // Build a field-sized backlog while unmounted so replay races live output.
        await streamWhileParked(setup, 100)

        // Throttle reveal so replay parse/corrective fit/follow-anchor races resemble a loaded machine.
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
      // Flap at varied phases to race gate claim/release against restore, exposing visible-pane byte drops.
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
      // Flap whole surfaces under CPU throttle to race suspension/heavy resume with gate resync/repaint.
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

      // Resize while parked so remount matches neither the prior grid nor daemon snapshot.
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
