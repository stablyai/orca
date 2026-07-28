/**
 * STA-2694 repro attempt: switching away from a workspace running an alt-screen
 * AI TUI (OpenCode/OpenTUI, also Claude Code and grok) and returning later shows
 * a garbled/distorted terminal that only a manual window resize repairs.
 *
 * Why this spec exists next to terminal-inline-tui-reveal-convergence.spec.ts:
 * that one drives the INLINE shape (normal buffer, live block glued to the
 * bottom, history scrolling into scrollback). OpenCode runs FULL-SCREEN on the
 * alternate buffer and repaints absolutely-positioned rows — nothing scrolls, so
 * no row ever self-heals through the scroll path. These tests cover that shape
 * across the hide/reveal boundaries (worktree switch, cold park, idle agent,
 * desktop hide) and guard the convergence properties we CAN observe: the buffer
 * converges to the live frame, the pane stays on the alt screen, and xterm's
 * grid, the fit proposal, and the PTY-applied size all agree without a resize.
 *
 * ⚠ These tests do NOT observe the CANVAS. Two pixel oracles were tried here and
 * both were proven blind by injecting the exact defect (freeze
 * RenderService.refreshRows, then write new content, so the buffer advances
 * while the canvas cannot):
 *
 *   1. Canvas-vs-buffer ink sampling (the render-desync sentinel's method).
 *      `drawImage` on a non-preserveDrawingBuffer WebGL canvas hands back a
 *      re-rendered copy, so it reported 0 missing cells against 5263 cells of
 *      text the canvas had never drawn.
 *   2. Screenshot comparison against a forced repaint. Playwright's screenshot
 *      drives a fresh compositor frame, which HEALS the stale paint before it
 *      is captured; and the "repair" calls the same repaint code the reveal
 *      already ran, so a defect shared by both shots cancels out.
 *
 * Pixels are the wrong layer for this: anything that reads them can trigger the
 * repaint that hides the bug. terminal-reveal-draw-command-probe.spec.ts solves
 * that by counting the WebGL draw commands a repaint issues, which cannot be
 * healed after the fact — use it for paint questions and this spec for buffer,
 * geometry, and PTY-size convergence.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { compareTerminalScreenshots } from './terminal-screenshot-diff'
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

const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500

test.use({
  orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) }
})

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'opencode-altscreen-live-fixture.cjs')
const FRAME_RE = /OPENCODE_FRAME_(\d+)/g
const TAIL_RE = /OPENCODE_TAIL_(\d+)/g
// The fixture ticks ~16x/s; allow generous parse/delivery lag while still
// rejecting a frame frozen from before the hide.
const MAX_VISIBLE_FRAME_LAG = 60

type RevealProbe = {
  ptyId: string | null
  cols: number
  rows: number
  bufferType: string
  proposed: { cols: number; rows: number } | null
  appliedPtySize: { cols: number; rows: number } | null
  screenRows: string[]
}

function latestMatch(text: string, pattern: RegExp): number {
  let latest = -1
  for (const match of text.matchAll(pattern)) {
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
        cols: terminal.cols,
        rows: terminal.rows,
        bufferType: buffer.type,
        proposed,
        appliedPtySize,
        screenRows
      }
    },
    { tabId }
  )
}

function describeProbe(probe: RevealProbe | null): string {
  if (!probe) {
    return 'pane not mounted'
  }
  return JSON.stringify(
    {
      cols: probe.cols,
      rows: probe.rows,
      bufferType: probe.bufferType,
      proposed: probe.proposed,
      appliedPtySize: probe.appliedPtySize,
      screenHead: probe.screenRows.slice(0, 4),
      screenTail: probe.screenRows.slice(-4)
    },
    null,
    1
  )
}

async function forceWebglOnActiveTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state?.settings) {
      throw new Error('Store unavailable')
    }
    window.__store?.setState({
      settings: { ...state.settings, terminalGpuAcceleration: 'on' }
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

async function hasWebglPane(page: Page, tabId: string): Promise<boolean> {
  return page.evaluate(
    (tabId) =>
      (window.__paneManagers?.get(tabId)?.getRenderingDiagnostics?.() ?? []).some(
        (diagnostic) => diagnostic.hasWebgl
      ),
    tabId
  )
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

type StreamingTabSetup = {
  worktreeId: string
  tabId: string
  ptyId: string
  heartbeatPath: string
  stop: () => Promise<void>
}

// Why agent-marked: a real OpenCode tab carries launchAgent/telemetry, which
// flips the reveal into the live-agent reattach branches (mode-preserving
// resets, hidden startup query grammar, post-replay focus-in) — the branches
// the field bug lives behind.
async function startStreamingAltScreenTui(
  page: Page,
  testInfo: TestInfo,
  options: { ticksPerSecond?: number } = {}
): Promise<StreamingTabSetup> {
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const heartbeatPath = testInfo.outputPath(`opencode-altscreen-heartbeat-${Date.now()}.txt`)
  const command = `node ${JSON.stringify(FIXTURE_PATH)} ${JSON.stringify(heartbeatPath)} ${options.ticksPerSecond ?? 16}`
  const tabId = await page.evaluate(
    ({ worktreeId, command }) => {
      const store = window.__store
      if (!store) {
        throw new Error('startStreamingAltScreenTui: window.__store is unavailable')
      }
      const state = store.getState()
      // Why 'codex' and not 'opencode': the agent marker exists only to take the
      // live-agent reattach branches, and codex is the kind the e2e environment
      // reliably launches (same choice as the inline-TUI convergence spec). The
      // TUI *shape* under test comes from the fixture, not from this marker.
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
      async () =>
        latestMatch((await probeRevealedPane(page, tabId))?.screenRows.join('\n') ?? '', FRAME_RE),
      {
        timeout: 20_000,
        message: 'alt-screen TUI fixture did not start streaming in the visible pane'
      }
    )
    .toBeGreaterThan(5)
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

// Buffer-level convergence: xterm parsed the live frames. This is necessary but
// NOT sufficient — the field bug shows a correct buffer behind garbled pixels.
async function assertBufferConverged(
  page: Page,
  testInfo: TestInfo,
  setup: StreamingTabSetup,
  label: string
): Promise<RevealProbe> {
  const { tabId, heartbeatPath } = setup
  expect(heartbeatFrame(heartbeatPath), 'fixture stopped streaming while hidden').toBeGreaterThan(5)

  let lastProbe: RevealProbe | null = null
  await expect
    .poll(
      async () => {
        lastProbe = await probeRevealedPane(page, tabId)
        if (!lastProbe) {
          return 'pane-not-mounted'
        }
        if (lastProbe.bufferType !== 'alternate') {
          return `not-alt-screen bufferType=${lastProbe.bufferType}`
        }
        const screen = lastProbe.screenRows.join('\n')
        const visibleFrame = latestMatch(screen, FRAME_RE)
        const visibleTail = latestMatch(screen, TAIL_RE)
        if (visibleTail < 0) {
          return 'status-row-missing'
        }
        const liveFrame = heartbeatFrame(heartbeatPath)
        if (visibleFrame < 0 || liveFrame - visibleFrame > MAX_VISIBLE_FRAME_LAG) {
          return `stale-frame visible=${visibleFrame} live=${liveFrame}`
        }
        return 'converged'
      },
      {
        timeout: 20_000,
        message: `${label}: revealed buffer did not converge to the live alt-screen TUI`
      }
    )
    .toBe('converged')
    .catch(async (error) => {
      testInfo.annotations.push({
        type: `${label}-buffer-divergence`,
        description: describeProbe(lastProbe)
      })
      throw error
    })

  const probe = await probeRevealedPane(page, tabId)
  expect(probe, `${label}: pane disappeared after convergence`).not.toBeNull()
  // Geometry: no stale-grid leg — xterm, fit proposal, and PTY must agree
  // without any manual resize.
  expect(probe!.proposed, `${label}: fit proposal diverges: ${describeProbe(probe)}`).toEqual({
    cols: probe!.cols,
    rows: probe!.rows
  })
  expect(
    probe!.appliedPtySize,
    `${label}: PTY applied size diverges: ${describeProbe(probe)}`
  ).toEqual({ cols: probe!.cols, rows: probe!.rows })
  return probe!
}

/**
 * SECONDARY, WEAK check: geometry-stable repaint equivalence.
 *
 * Freeze the TUI, screenshot, force a clean rebuild in-app (atlas clear + full
 * refresh), screenshot again, and require the two to match.
 *
 * Why weak, despite looking decisive: the "repair" runs the same repaint code
 * the reveal already ran, so a defect present in BOTH shots cancels out and the
 * comparison reports success. Injecting a frozen renderer proved that blind
 * spot. Treat a green result as "the reveal did not leave a repaint-visible
 * difference", never as proof the canvas painted correctly.
 *
 * The sound paint oracles live elsewhere: terminal-reveal-draw-command-probe
 * counts WebGL draw commands (unhealable after the fact), and
 * terminal-reveal-latch-visual-evidence captures the stale pixels directly.
 */
async function assertRevealPixelsNeedNoRepair(
  page: Page,
  testInfo: TestInfo,
  setup: StreamingTabSetup,
  label: string
): Promise<void> {
  const { tabId, ptyId } = setup
  // Freeze the fixture in place: it stops emitting frames but stays on the alt
  // screen holding its last frame. Quitting would leave a shell prompt, and a
  // live stream would differ between the two shots for legitimate reasons.
  await sendToTerminal(page, ptyId, 'ORCA_FREEZE_NOW').catch(() => {})
  await page.waitForTimeout(2_000)

  // Guard against a vacuous comparison: both shots must show a real TUI frame.
  const frozenProbe = await probeRevealedPane(page, tabId)
  expect(
    frozenProbe?.bufferType,
    `${label}: fixture left the alt screen before the paint check: ${describeProbe(frozenProbe)}`
  ).toBe('alternate')
  expect(
    latestMatch(frozenProbe?.screenRows.join('\n') ?? '', FRAME_RE),
    `${label}: no TUI frame on screen for the paint check: ${describeProbe(frozenProbe)}`
  ).toBeGreaterThan(0)

  const clip = await paneClipRect(page, tabId)
  expect(clip, `${label}: pane rect unavailable for paint check`).not.toBeNull()
  const revealed = await page.screenshot({ clip: clip! })

  // The in-app equivalent of the user's manual resize repair, with the geometry
  // untouched: clear the glyph atlas and force a full repaint from the buffer.
  const rebuilt = await page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    if (!manager) {
      return false
    }
    manager.resetWebglTextureAtlases?.()
    manager.refreshAllPanes?.()
    return true
  }, tabId)
  expect(rebuilt, `${label}: could not force a clean repaint`).toBe(true)
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
  await page.waitForTimeout(600)

  const repairedClip = await paneClipRect(page, tabId)
  expect(repairedClip, `${label}: pane rect unavailable after repaint`).not.toBeNull()
  // Geometry must be identical, or the comparison is not apples-to-apples.
  expect(repairedClip, `${label}: pane geometry moved during the repaint`).toEqual(clip)
  const repaired = await page.screenshot({ clip: repairedClip! })

  writeFileSync(testInfo.outputPath(`${label}-revealed.png`), revealed)
  writeFileSync(testInfo.outputPath(`${label}-after-clean-repaint.png`), repaired)

  // Anti-vacuity: a blank-vs-blank comparison would "match" trivially. The
  // repainted shot is the known-good reference, so require real glyph ink.
  const repairedInk = measureInkRatio(repaired)
  expect(
    repairedInk,
    `${label}: repainted pane has no glyphs (ink ${repairedInk.toFixed(4)}) — ` +
      'the screenshot is not capturing terminal content, so the comparison is vacuous'
  ).toBeGreaterThan(0.01)

  const diff = compareTerminalScreenshots(repaired, revealed)
  expect(
    diff.matches,
    `${label}: revealed canvas did not match a clean repaint of its own buffer ` +
      `(diff ${diff.diffPixels}px, ratio ${diff.diffRatio.toFixed(4)}) — this is STA-2694`
  ).toBe(true)
}

// Fraction of pixels differing from the dominant (background) color.
function measureInkRatio(screenshot: Buffer): number {
  const png = PNG.sync.read(screenshot)
  const counts = new Map<number, number>()
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const key =
      ((png.data[offset] ?? 0) << 16) |
      ((png.data[offset + 1] ?? 0) << 8) |
      (png.data[offset + 2] ?? 0)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let backgroundKey = 0
  let backgroundCount = -1
  for (const [key, count] of counts) {
    if (count > backgroundCount) {
      backgroundKey = key
      backgroundCount = count
    }
  }
  const backgroundRed = (backgroundKey >> 16) & 0xff
  const backgroundGreen = (backgroundKey >> 8) & 0xff
  const backgroundBlue = backgroundKey & 0xff
  let ink = 0
  let total = 0
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const distance =
      Math.abs((png.data[offset] ?? 0) - backgroundRed) +
      Math.abs((png.data[offset + 1] ?? 0) - backgroundGreen) +
      Math.abs((png.data[offset + 2] ?? 0) - backgroundBlue)
    total += 1
    if (distance > 48) {
      ink += 1
    }
  }
  return total > 0 ? ink / total : 0
}

// Reads xterm's live DEC 2026 latch for the pane. While true, RenderService
// buffers every refresh instead of rendering it.
async function readSynchronizedOutputLatch(page: Page, tabId: string): Promise<boolean | null> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const modes = (
      pane?.terminal as unknown as
        | { _core?: { coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } } } }
        | undefined
    )?._core?.coreService?.decPrivateModes
    return modes ? modes.synchronizedOutput === true : null
  }, tabId)
}

async function streamWhileHidden(setup: StreamingTabSetup, minFrames: number): Promise<void> {
  const heartbeatBefore = heartbeatFrame(setup.heartbeatPath)
  await expect
    .poll(() => heartbeatFrame(setup.heartbeatPath), {
      timeout: 60_000,
      message: 'fixture did not keep streaming while hidden/parked'
    })
    .toBeGreaterThan(heartbeatBefore + minFrames)
}

test.describe('OpenCode alt-screen reveal artifacts (STA-2694)', () => {
  test('worktree switch away and back paints correctly without a manual resize', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(180_000)
    const setup = await startStreamingAltScreenTui(orcaPage, testInfo)
    try {
      test.skip(
        !(await hasWebglPane(orcaPage, setup.tabId)),
        'WebGL renderer unavailable in this environment'
      )
      // The field action: switch away to another workspace (suspends rendering
      // and releases WebGL), let the agent keep streaming, then come back.
      const otherWorktreeId = await switchToOtherWorktree(orcaPage, setup.worktreeId)
      test.skip(!otherWorktreeId, 'test session has a single worktree; cannot surface-hide')
      await streamWhileHidden(setup, 120)

      await withCpuThrottle(orcaPage, 6, async () => {
        await switchToWorktree(orcaPage, setup.worktreeId)
        await activateTerminalTab(orcaPage, setup.tabId)
        await waitForActiveTerminalManager(orcaPage, 30_000)
        await orcaPage.waitForTimeout(2_000)
      })

      await assertBufferConverged(orcaPage, testInfo, setup, 'worktree-return')
      await assertRevealPixelsNeedNoRepair(orcaPage, testInfo, setup, 'worktree-return')
    } finally {
      await setup.stop()
    }
  })

  test('parked tab reveal paints correctly without a manual resize', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(240_000)
    const setup = await startStreamingAltScreenTui(orcaPage, testInfo, { ticksPerSecond: 20 })
    try {
      test.skip(
        !(await hasWebglPane(orcaPage, setup.tabId)),
        'WebGL renderer unavailable in this environment'
      )
      // Tab B hides tab A; the decoy then hides B so B takes the last-active
      // exemption and tab A genuinely cold-parks (renderer torn down).
      await createActiveTerminalTab(orcaPage, setup.worktreeId)
      await createActiveTerminalTab(orcaPage, setup.worktreeId)
      await waitForTabParked(orcaPage, setup.tabId, { parkDelayMs: PARKING_DELAY_MS })
      await streamWhileHidden(setup, 150)

      await withCpuThrottle(orcaPage, 6, async () => {
        await activateTerminalTab(orcaPage, setup.tabId)
        await waitForActiveTerminalManager(orcaPage, 30_000)
        await orcaPage.waitForTimeout(3_000)
      })

      await assertBufferConverged(orcaPage, testInfo, setup, 'parked-reveal')
      await assertRevealPixelsNeedNoRepair(orcaPage, testInfo, setup, 'parked-reveal')
    } finally {
      await setup.stop()
    }
  })

  // The field condition the other tests miss: the agent is IDLE when you come
  // back. Every test above keeps the TUI streaming across the reveal, so live
  // frames repaint whatever the reveal got wrong — the defect heals itself
  // before any assertion runs. A real OpenCode session sits waiting for input,
  // so nothing arrives to heal it, and whatever the reveal painted is what the
  // user stares at until they resize the window.
  test('parked reveal of an IDLE alt-screen agent paints without a manual repair', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(240_000)
    const setup = await startStreamingAltScreenTui(orcaPage, testInfo)
    try {
      test.skip(
        !(await hasWebglPane(orcaPage, setup.tabId)),
        'WebGL renderer unavailable in this environment'
      )
      // Go idle BEFORE hiding, cleanly between brackets — a settled agent
      // holding its last full-screen frame.
      await sendToTerminal(orcaPage, setup.ptyId, 'ORCA_FREEZE_NOW').catch(() => {})
      await orcaPage.waitForTimeout(2_000)
      const idleFrame = latestMatch(
        (await probeRevealedPane(orcaPage, setup.tabId))?.screenRows.join('\n') ?? '',
        FRAME_RE
      )
      expect(idleFrame, 'fixture never painted a frame before going idle').toBeGreaterThan(0)

      // Cold-park the idle tab: renderer torn down, so the reveal must restore
      // and repaint entirely from the snapshot with no live output to help.
      await createActiveTerminalTab(orcaPage, setup.worktreeId)
      await createActiveTerminalTab(orcaPage, setup.worktreeId)
      await waitForTabParked(orcaPage, setup.tabId, { parkDelayMs: PARKING_DELAY_MS })
      await orcaPage.waitForTimeout(3_000)

      await withCpuThrottle(orcaPage, 6, async () => {
        await activateTerminalTab(orcaPage, setup.tabId)
        await waitForActiveTerminalManager(orcaPage, 30_000)
        await orcaPage.waitForTimeout(3_000)
      })

      // The same frame must still be on screen — the agent produced nothing new.
      const revealedProbe = await probeRevealedPane(orcaPage, setup.tabId)
      expect(
        revealedProbe?.bufferType,
        `idle-parked-reveal: pane is not on the alt screen: ${describeProbe(revealedProbe)}`
      ).toBe('alternate')
      expect(
        latestMatch(revealedProbe?.screenRows.join('\n') ?? '', FRAME_RE),
        `idle-parked-reveal: idle frame lost across the park: ${describeProbe(revealedProbe)}`
      ).toBeGreaterThan(0)

      await assertRevealPixelsNeedNoRepair(orcaPage, testInfo, setup, 'idle-parked-reveal')
    } finally {
      await setup.stop()
    }
  })

  // The LITERAL user action: "switch away to the desktop". That is an OS-level
  // window hide/occlusion, not in-app navigation — it flips
  // document.visibilityState, releases the WebGL context, and comes back
  // through the window-wake recovery path rather than the worktree-reveal path.
  // The pane never unmounts and its worktree never changes, so none of the
  // reveal-repaint machinery the other tests exercise even runs.
  test('@headful desktop switch away and back paints an idle agent without a manual repair', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    test.setTimeout(240_000)
    const setup = await startStreamingAltScreenTui(orcaPage, testInfo)
    try {
      test.skip(
        !(await hasWebglPane(orcaPage, setup.tabId)),
        'WebGL renderer unavailable in this environment'
      )
      // Idle agent holding a full-screen frame — the field state on return.
      await sendToTerminal(orcaPage, setup.ptyId, 'ORCA_FREEZE_NOW').catch(() => {})
      await orcaPage.waitForTimeout(2_000)

      // Switch away to the desktop: hide the window entirely.
      await electronApp.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (!window) {
          throw new Error('No Electron window')
        }
        window.hide()
      })
      await orcaPage.waitForTimeout(4_000)

      // ...and come back to it.
      await electronApp.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (!window) {
          throw new Error('No Electron window')
        }
        window.show()
        window.focus()
      })
      await orcaPage.waitForTimeout(3_000)

      const revealedProbe = await probeRevealedPane(orcaPage, setup.tabId)
      expect(
        revealedProbe?.bufferType,
        `desktop-return: pane is not on the alt screen: ${describeProbe(revealedProbe)}`
      ).toBe('alternate')

      await assertRevealPixelsNeedNoRepair(orcaPage, testInfo, setup, 'desktop-return')
    } finally {
      await electronApp
        .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
        .catch(() => {})
      await setup.stop()
    }
  })

  // The mechanism behind STA-2694: OpenTUI-style TUIs bracket every repaint in
  // `?2026h … ?2026l`, so a hide can land inside an open bracket. xterm then
  // keeps synchronizedOutput latched, and RenderService checks that latch
  // BEFORE rendering — so on reveal the forced repaint, the plain refresh
  // fallback, and the glyph-atlas rebuild all render zero rows while the buffer
  // is perfectly correct. A window resize "fixes" it only because SIGWINCH
  // makes the TUI emit the closing `?2026l`.
  test('reveal repaints a pane hidden inside an unclosed synchronized-output frame', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(180_000)
    const setup = await startStreamingAltScreenTui(orcaPage, testInfo)
    try {
      // Stop the TUI mid-bracket, then hide — the exact field sequence.
      await sendToTerminal(orcaPage, setup.ptyId, 'ORCA_FREEZE_MID_FRAME').catch(() => {})
      // Why poll instead of a fixed wait: xterm arms a 1s safety timeout that
      // clears the latch on its own, so a longer sleep would sample after the
      // watchdog fired and miss the very state under test.
      await expect
        .poll(() => readSynchronizedOutputLatch(orcaPage, setup.tabId), {
          timeout: 5_000,
          intervals: [50],
          message: 'fixture did not leave a synchronized-output frame open'
        })
        .toBe(true)

      const otherWorktreeId = await switchToOtherWorktree(orcaPage, setup.worktreeId)
      test.skip(!otherWorktreeId, 'test session has a single worktree; cannot surface-hide')
      // Why re-check here: the pane was still VISIBLE between the freeze and this
      // switch, so refreshes reached bufferRows and armed xterm's 1s watchdog. If
      // it fired before the hide, the pane is now unlatched and the final
      // assertion would pass without the defect ever existing.
      expect(
        await readSynchronizedOutputLatch(orcaPage, setup.tabId),
        'the watchdog cleared the latch before the hide, so this run proves nothing'
      ).toBe(true)
      await orcaPage.waitForTimeout(2_500)
      await switchToWorktree(orcaPage, setup.worktreeId)
      await activateTerminalTab(orcaPage, setup.tabId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await orcaPage.waitForTimeout(2_500)

      // The reveal must not leave the pane wedged behind the stale latch: while
      // it holds, nothing this pane can do repaints a single row.
      expect(
        await readSynchronizedOutputLatch(orcaPage, setup.tabId),
        'reveal left a stale synchronized-output latch, so every repaint is swallowed'
      ).toBe(false)
      await assertRevealPixelsNeedNoRepair(orcaPage, testInfo, setup, 'mid-frame-hide')
    } finally {
      await setup.stop()
    }
  })
})
