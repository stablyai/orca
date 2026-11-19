import type { XtermWithRenderDimensions } from './xterm-render-dimensions'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  buildAltScreenFrame,
  describeAltScreenRenderPath,
  readRenderedAltScreenFrame,
  writeToPaneTerminal
} from '../output/alt-screen-frame'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getActiveWorktreeId,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'
import '../input/terminal'
import { sendToTerminal, waitForActiveTerminalManager } from '../layout/terminal-pane-operations'

import { compareTerminalScreenshots } from './terminal-screenshot-diff'
import { captureStableTabScreenshot } from './terminal-tab-screenshot'

const SILENT_FOREGROUND_COMMAND = 'node -e "setInterval(() => {}, 1000)"\r'
const TAB_A_GLYPH_ROW = 'abcdefghijklmnopqrstuvwxyz 0123456789 []{}<>/\\#@%&*+=~'
const TAB_B_GLYPH_ROW = 'ZYXWVUTSRQPONMLKJIHGFEDCBA 9876543210 !?^"\'();:,.|$_-'

type TabTerminalGeometry = {
  tabId: string
  overlayWidth: number
  overlayHeight: number
  overlayDisplay: string
  cols: number
  rows: number
  cellWidth: number
  screenWidth: number
  screenRight: number
  rowRight: number
  contentWidthRatio: number
  markerPresent: boolean
  hasWebgl: boolean
}

const TAB_SWITCH_MARKER_PREFIX = 'TAB_SWITCH_VISUAL_RESTORE'

type HiddenOutputDebugSnapshot = {
  hiddenRendererSkipCount: number
  hiddenRendererSkippedChars: number
}

type HiddenOutputRecoveryWindow = Window & {
  __terminalPtyDataInjection?: {
    inject: (paneKey: string, data: string, meta?: { seq?: number; rawLength?: number }) => boolean
  }
  __terminalPtyOutputDebug?: {
    reset: () => void
    snapshot: () => HiddenOutputDebugSnapshot
  }
  __terminalHiddenSnapshotOverride?: {
    setPending: (
      ptyId: string,
      snapshot: { data: string; cols: number; rows: number; seq?: number }
    ) => void
    resolve: (ptyId: string) => void
    clear: (ptyId: string) => void
  }
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

async function ensureTwoTerminalTabs(
  page: Page
): Promise<{ firstTabId: string; secondTabId: string }> {
  const worktreeId = (await getActiveWorktreeId(page))!
  if ((await page.locator('[data-testid="sortable-tab"]').count()) < 2) {
    await page.getByRole('button', { name: 'New tab' }).click({ force: true })
    await page
      .getByRole('menu')
      .getByRole('button', { name: /New Terminal/i })
      .first()
      .click({ force: true })
    await expect
      .poll(() => page.locator('[data-testid="sortable-tab"]').count(), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)
  }
  const firstTabId = (await getActiveTabId(page))!
  const secondTabId = await page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const tabs = state.tabsByWorktree[worktreeId] ?? []
    const other = tabs.find((tab) => tab.id !== state.activeTabId)
    return other?.id ?? null
  }, worktreeId)
  if (!secondTabId) {
    throw new Error('Expected a second terminal tab')
  }
  return { firstTabId, secondTabId }
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store.getState().setActiveTab(id)
    store.getState().setActiveTabType('terminal', store.getState().activeWorktreeId)
  }, tabId)
  await expect
    .poll(
      () =>
        page
          .locator(`[data-testid="sortable-tab"][data-active="true"]`)
          .getAttribute('data-tab-id'),
      {
        timeout: 3_000
      }
    )
    .toBe(tabId)
}

async function waitForWebglOnTab(page: Page, tabId: string): Promise<boolean> {
  return page
    .waitForFunction(
      (id) => {
        const diagnostics = window.__paneManagers?.get(id)?.getRenderingDiagnostics?.() ?? []
        return diagnostics.some((entry) => entry.hasWebgl)
      },
      tabId,
      { timeout: 15_000 }
    )
    .then(() => true)
    .catch(() => false)
}

async function waitForPanePtyIdOnTab(page: Page, tabId: string): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const manager = window.__paneManagers?.get(id)
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return pane?.container?.dataset?.ptyId ?? null
        }, tabId),
      { timeout: 15_000, message: `Pane for tab ${tabId} did not receive a PTY binding` }
    )
    .not.toBeNull()
  const ptyId = await page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return pane?.container?.dataset?.ptyId ?? null
  }, tabId)
  if (!ptyId) {
    throw new Error(`Pane for tab ${tabId} has no PTY binding`)
  }
  return ptyId
}

async function readPaneIdentityOnTab(
  page: Page,
  tabId: string
): Promise<{ leafId: string; ptyId: string; cols: number; rows: number }> {
  const identity = await page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      return null
    }
    return {
      leafId: pane.container.dataset.leafId ?? null,
      ptyId: pane.container.dataset.ptyId ?? null,
      cols: pane.terminal.cols,
      rows: pane.terminal.rows
    }
  }, tabId)
  if (!identity?.leafId || !identity.ptyId) {
    throw new Error(`Pane identity for tab ${tabId} is incomplete`)
  }
  return {
    leafId: identity.leafId,
    ptyId: identity.ptyId,
    cols: identity.cols,
    rows: identity.rows
  }
}

async function setHiddenSnapshotOverride(
  page: Page,
  ptyId: string,
  snapshot: { data: string; cols: number; rows: number; seq?: number }
): Promise<void> {
  await page.evaluate(
    ({ ptyId, snapshot }) => {
      const api = (window as HiddenOutputRecoveryWindow).__terminalHiddenSnapshotOverride
      if (!api) {
        throw new Error('Hidden snapshot override API unavailable')
      }
      api.setPending(ptyId, snapshot)
      api.resolve(ptyId)
    },
    { ptyId, snapshot }
  )
}

async function writeStaticTabContent(
  page: Page,
  tabId: string,
  marker: string,
  glyphRow: string
): Promise<void> {
  await page.evaluate(
    async ({ id, marker, glyphRow }) => {
      const manager = window.__paneManagers?.get(id)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!pane) {
        throw new Error(`Pane unavailable for tab ${id}`)
      }
      const rows = Array.from(
        { length: 14 },
        (_, row) => `${marker} row ${row} | ${glyphRow} |\r\n`
      ).join('')
      await new Promise<void>((resolve) =>
        pane.terminal.write(`\x1b[2J\x1b[3J\x1b[H\x1b[?25l${rows}`, resolve)
      )
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    },
    { id: tabId, marker, glyphRow }
  )
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
}

async function resetAtlasOnTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    window.__paneManagers?.get(id)?.resetWebglTextureAtlases?.()
  }, tabId)
}

async function readTabTerminalGeometry(
  page: Page,
  tabId: string,
  runId: string
): Promise<TabTerminalGeometry> {
  const marker = `${TAB_SWITCH_MARKER_PREFIX}_${runId}`
  return page.evaluate(
    ({ tabId, marker }) => {
      const overlay = document.querySelector<HTMLElement>(
        `[data-terminal-overlay-tab-id="${tabId}"]`
      )
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
      if (!pane) {
        throw new Error(`No terminal pane for tab ${tabId}`)
      }
      const overlayRect = overlay?.getBoundingClientRect()
      const screen = pane.container.querySelector<HTMLElement>('.xterm-screen')
      if (!screen) {
        throw new Error(`No xterm screen for tab ${tabId}`)
      }
      const screenRect = screen.getBoundingClientRect()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm has no public cell-size API; the private render service is read through all-optional fields.
      const xterm = pane.terminal as XtermWithRenderDimensions
      const cellWidth = xterm._core?._renderService?.dimensions?.css?.cell?.width ?? 0
      const renderedContentWidth = pane.terminal.cols * cellWidth
      const rowRight = screenRect.left + renderedContentWidth
      const contentWidthRatio = screenRect.width > 0 ? renderedContentWidth / screenRect.width : 0
      const buffer = pane.terminal.buffer.active
      let markerPresent = false
      for (let row = 0; row < pane.terminal.rows; row += 1) {
        const line = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
        if (line.includes(marker)) {
          markerPresent = true
          break
        }
      }
      const diagnostics = manager?.getRenderingDiagnostics?.() ?? []
      const hasWebgl = diagnostics.some((entry) => entry.hasWebgl)
      return {
        tabId,
        overlayWidth: overlayRect?.width ?? 0,
        overlayHeight: overlayRect?.height ?? 0,
        overlayDisplay: overlay ? window.getComputedStyle(overlay).display : 'missing',
        cols: pane.terminal.cols,
        rows: pane.terminal.rows,
        cellWidth,
        screenWidth: screenRect.width,
        screenRight: screenRect.right,
        rowRight,
        contentWidthRatio,
        markerPresent,
        hasWebgl
      }
    },
    { tabId, marker }
  )
}

function geometryLooksCorrupted(geometry: TabTerminalGeometry): string | null {
  if (geometry.overlayDisplay === 'none') {
    return 'overlay still display:none after activation'
  }
  if (geometry.overlayWidth < 200 || geometry.overlayHeight <= 0) {
    return `overlay dimensions invalid (${geometry.overlayWidth}x${geometry.overlayHeight}px)`
  }
  if (geometry.cols < 40 || geometry.rows <= 0) {
    return `terminal grid invalid (${geometry.cols}x${geometry.rows})`
  }
  // Reject the half-width bug: stale cols leave rowRight far behind screenRight.
  if (geometry.contentWidthRatio > 0 && geometry.contentWidthRatio < 0.82) {
    return `content width ratio ${geometry.contentWidthRatio.toFixed(3)} < 0.82`
  }
  if (
    geometry.screenWidth > 0 &&
    geometry.rowRight < geometry.screenRight - geometry.cellWidth * 4
  ) {
    return `rowRight ${geometry.rowRight.toFixed(1)} lags screenRight ${geometry.screenRight.toFixed(1)}`
  }
  return null
}

async function captureTabScreenshot(
  page: Page,
  tabId: string,
  testInfo: TestInfo,
  label: string
): Promise<void> {
  const overlay = page.locator(`[data-terminal-overlay-tab-id="${tabId}"]`)
  const path = testInfo.outputPath(`${label}-${tabId}.png`)
  await overlay.screenshot({ path })
  await testInfo.attach(`${label}.png`, { path, contentType: 'image/png' })
}

test.describe('Terminal tab switch visual restore', () => {
  test.describe.configure({ mode: 'serial' })

  test('keeps geometry after hidden alt-screen TUI redraws during tab switches', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const { firstTabId, secondTabId } = await ensureTwoTerminalTabs(orcaPage)
    await forceWebglOnActiveTab(orcaPage)
    await waitForPanePtyIdOnTab(orcaPage, firstTabId)

    const runId = `${Date.now()}`
    const finalMarker = `${TAB_SWITCH_MARKER_PREFIX}_${runId}_ALT_24`

    await writeToPaneTerminal(
      orcaPage,
      firstTabId,
      Array.from({ length: 25 }, (_, frame) => buildAltScreenFrame(finalMarker, frame)).join('')
    )

    const corruptionReports: string[] = []
    const renderPaths: string[] = []
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const liveFrame = cycle * 4
      const restoreFrame = liveFrame + 1
      const redraw = buildAltScreenFrame(finalMarker, liveFrame)
      // Direct-emulator frames bypass main’s model; publish an equivalent snapshot numbered one higher to identify which restore path paints.
      // Re-read identity each cycle because reattach can re-key the override.
      const { ptyId, cols, rows } = await readPaneIdentityOnTab(orcaPage, firstTabId)
      await setHiddenSnapshotOverride(orcaPage, ptyId, {
        data: buildAltScreenFrame(finalMarker, restoreFrame),
        cols,
        rows
      })
      await activateTerminalTab(orcaPage, secondTabId)
      await writeToPaneTerminal(orcaPage, firstTabId, redraw)
      await activateTerminalTab(orcaPage, firstTabId)

      const geometry = await readTabTerminalGeometry(orcaPage, firstTabId, `${runId}_ALT`)
      const renderedFrame = await readRenderedAltScreenFrame(orcaPage, firstTabId, finalMarker)
      renderPaths.push(
        `cycle ${cycle}: ${describeAltScreenRenderPath(renderedFrame, liveFrame, restoreFrame)}`
      )
      // Require the winning path’s own frame; other content means stale restore.
      const staleFrame =
        renderedFrame !== null && renderedFrame !== liveFrame && renderedFrame !== restoreFrame
          ? `alt-screen shows frame ${renderedFrame}, expected ${liveFrame} (live write) or ${restoreFrame} (reveal restore)`
          : null
      const issue = geometryLooksCorrupted(geometry) ?? staleFrame
      if (issue || !geometry.markerPresent) {
        corruptionReports.push(
          `cycle ${cycle}: ${issue ?? 'marker missing after alt-screen redraw'}`
        )
        await captureTabScreenshot(
          orcaPage,
          firstTabId,
          testInfo,
          `alt-screen-corrupt-cycle-${cycle}`
        )
      }
    }

    // Record load-dependent restore-path winners rather than assert them; stdout keeps the list reporter from hiding this evidence.
    testInfo.annotations.push({
      type: 'alt-screen-render-path',
      description: renderPaths.join(', ')
    })
    console.log('[tab-switch-repro] alt-screen render path:', renderPaths.join(', '))

    expect(
      corruptionReports,
      corruptionReports.length > 0
        ? `alt-screen hidden redraw left corrupted geometry:\n${corruptionReports.join('\n')}`
        : undefined
    ).toEqual([])
  })

  test('@headful keeps returned tab glyphs intact across tab switches', async ({
    orcaPage
  }, testInfo) => {
    // Compare screenshots to catch atlas corruption beyond correct cols/rows.
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const { firstTabId, secondTabId } = await ensureTwoTerminalTabs(orcaPage)
    await forceWebglOnActiveTab(orcaPage)
    await activateTerminalTab(orcaPage, firstTabId)
    const firstWebgl = await waitForWebglOnTab(orcaPage, firstTabId)
    await activateTerminalTab(orcaPage, secondTabId)
    await orcaPage.evaluate((id) => {
      window.__paneManagers?.get(id)?.setTerminalGpuAcceleration?.('on')
    }, secondTabId)
    const secondWebgl = await waitForWebglOnTab(orcaPage, secondTabId)
    if (!firstWebgl || !secondWebgl) {
      test.skip(true, 'WebGL never attached on both tabs')
      return
    }

    const firstPtyId = await waitForPanePtyIdOnTab(orcaPage, firstTabId)
    const secondPtyId = await waitForPanePtyIdOnTab(orcaPage, secondTabId)
    await sendToTerminal(orcaPage, firstPtyId, SILENT_FOREGROUND_COMMAND)
    await sendToTerminal(orcaPage, secondPtyId, SILENT_FOREGROUND_COMMAND)
    await orcaPage.waitForTimeout(1_000)

    const runId = `${Date.now()}`
    const markerA = `${TAB_SWITCH_MARKER_PREFIX}_A_${runId}`
    const markerB = `${TAB_SWITCH_MARKER_PREFIX}_B_${runId}`
    await writeStaticTabContent(orcaPage, firstTabId, markerA, TAB_A_GLYPH_ROW)
    await activateTerminalTab(orcaPage, secondTabId)
    await writeStaticTabContent(orcaPage, secondTabId, markerB, TAB_B_GLYPH_ROW)

    await activateTerminalTab(orcaPage, firstTabId)
    await resetAtlasOnTab(orcaPage, firstTabId)
    await orcaPage.waitForTimeout(800)
    const baseline = await captureStableTabScreenshot(orcaPage, firstTabId)

    const screenshotMismatches: string[] = []
    for (let cycle = 0; cycle < 8; cycle += 1) {
      await activateTerminalTab(orcaPage, secondTabId)
      // Keep hidden content unchanged so screenshot equality isolates suspend/resume and atlas reset.
      await activateTerminalTab(orcaPage, firstTabId)
      await orcaPage.waitForTimeout(100)
      const afterReturn = await captureStableTabScreenshot(orcaPage, firstTabId)
      const diff = compareTerminalScreenshots(baseline, afterReturn)
      if (!diff.matches) {
        screenshotMismatches.push(
          `cycle ${cycle}: ${diff.diffPixels} px (${(diff.diffRatio * 100).toFixed(2)}%)`
        )
        await testInfo.attach(`after-return-cycle-${cycle}`, {
          body: afterReturn,
          contentType: 'image/png'
        })
      }
    }

    await testInfo.attach('baseline', { body: baseline, contentType: 'image/png' })
    expect(
      screenshotMismatches,
      screenshotMismatches.length > 0
        ? `returned tab glyphs changed after switch cycles: ${screenshotMismatches.join(', ')}`
        : undefined
    ).toEqual([])
  })
})
