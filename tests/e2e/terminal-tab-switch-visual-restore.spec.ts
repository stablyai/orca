import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getActiveWorktreeId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActiveTerminalManager
} from './helpers/terminal'
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

type TerminalOutputSchedulerSnapshot = {
  backgroundEnqueueCount: number
  scheduledDrainCount: number
  queuedChars: number
}

type SchedulerDebugWindow = Window & {
  __terminalOutputSchedulerDebug?: {
    reset: () => void
    snapshot: () => TerminalOutputSchedulerSnapshot
  }
}

type HiddenOutputDebugSnapshot = {
  hiddenRendererSkipCount: number
  hiddenRendererSkippedChars: number
  hiddenRendererMode2031ReplyCount: number
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
      .getByRole('menuitem', { name: /New Terminal/i })
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

async function createAgentMarkedTerminalTab(
  page: Page,
  agent: 'codex' | 'grok',
  command: string
): Promise<string> {
  const worktreeId = (await getActiveWorktreeId(page))!
  return page.evaluate(
    ({ worktreeId, agent, command }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const state = store.getState()
      const tab = state.createTab(worktreeId, undefined, undefined, {
        launchAgent: agent
      })
      state.queueTabStartupCommand(tab.id, {
        command,
        launchAgent: agent,
        telemetry: {
          agent_kind: agent,
          launch_source: 'tab_bar_quick_launch',
          request_kind: 'new'
        }
      })
      state.setActiveTab(tab.id)
      state.setActiveTabType('terminal')
      return tab.id
    },
    { worktreeId, agent, command }
  )
}

async function createCodexMarkedTerminalTab(page: Page): Promise<string> {
  return createAgentMarkedTerminalTab(page, 'codex', 'node -e "setInterval(() => {}, 1000)"')
}

async function createGrokMarkedTerminalTab(page: Page): Promise<string> {
  return createAgentMarkedTerminalTab(page, 'grok', 'node -e "setInterval(() => {}, 1000)"')
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store.getState().setActiveTab(id)
    store.getState().setActiveTabType('terminal')
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

async function resetHiddenOutputDebug(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as HiddenOutputRecoveryWindow).__terminalPtyOutputDebug?.reset()
  })
}

async function readHiddenOutputDebug(page: Page): Promise<HiddenOutputDebugSnapshot | null> {
  return page.evaluate(() => {
    return (window as HiddenOutputRecoveryWindow).__terminalPtyOutputDebug?.snapshot() ?? null
  })
}

async function injectPaneData(
  page: Page,
  paneKey: string,
  data: string,
  meta?: { seq?: number; rawLength?: number }
): Promise<void> {
  const injected = await page.evaluate(
    ({ paneKey, data, meta }) =>
      (window as HiddenOutputRecoveryWindow).__terminalPtyDataInjection?.inject(
        paneKey,
        data,
        meta
      ) ?? false,
    { paneKey, data, meta }
  )
  if (!injected) {
    throw new Error(`No terminal PTY data injector registered for ${paneKey}`)
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

async function resetTerminalOutputSchedulerDebug(page: Page): Promise<void> {
  await page.evaluate(() => {
    const debug = (window as SchedulerDebugWindow).__terminalOutputSchedulerDebug
    if (!debug) {
      throw new Error('Terminal output scheduler debug API unavailable')
    }
    debug.reset()
  })
}

async function waitForHiddenOutputSchedulerActivity(
  page: Page
): Promise<TerminalOutputSchedulerSnapshot> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const snapshot = (
            window as SchedulerDebugWindow
          ).__terminalOutputSchedulerDebug?.snapshot()
          return snapshot?.backgroundEnqueueCount ?? 0
        }),
      {
        timeout: 5_000,
        message: 'hidden PTY output did not reach the background output scheduler'
      }
    )
    .toBeGreaterThan(0)
  return page.evaluate(() => {
    const snapshot = (window as SchedulerDebugWindow).__terminalOutputSchedulerDebug?.snapshot()
    if (!snapshot) {
      throw new Error('Terminal output scheduler debug API unavailable')
    }
    return {
      backgroundEnqueueCount: snapshot.backgroundEnqueueCount,
      scheduledDrainCount: snapshot.scheduledDrainCount,
      queuedChars: snapshot.queuedChars
    }
  })
}

async function startHiddenPtyOutputBurst(page: Page, ptyId: string, runId: string): Promise<void> {
  const marker = `${TAB_SWITCH_MARKER_PREFIX}_PTY_${runId}`
  const script = [
    `const marker=${JSON.stringify(marker)};`,
    'setTimeout(()=>{',
    'let frame=0;',
    'const timer=setInterval(()=>{',
    'console.log(`${marker} frame=${String(frame).padStart(3,"0")} abcdefghijklmnopqrstuvwxyz 0123456789 []{}<>/\\\\#@%&*+=~`);',
    'frame+=1;',
    'if(frame>=180) clearInterval(timer);',
    '},1);',
    '},30);'
  ].join('')
  await sendToTerminal(page, ptyId, `node -e ${JSON.stringify(script)}\r`)
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

async function injectHiddenStreamingBurst(page: Page, tabId: string, runId: string): Promise<void> {
  const marker = `${TAB_SWITCH_MARKER_PREFIX}_${runId}`
  await page.evaluate(
    ({ tabId, marker }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
      if (!pane) {
        throw new Error(`No terminal pane for tab ${tabId}`)
      }
      // Why: Grok sessions can emit large formatted bursts while the tab is
      // hidden; stress the visibility-resume flush path beyond a few lines.
      const burst = Array.from({ length: 400 }, (_, frame) => {
        const progress = `${'█'.repeat((frame % 16) + 1)}${'░'.repeat(16 - ((frame % 16) + 1))}`
        return [
          `hidden_stream frame=${String(frame).padStart(3, '0')} ${marker}`,
          `Dimension              │ Rating                                              │`,
          `status ${frame % 2 === 0 ? 'thinking' : 'streaming'} ${progress}`,
          `abcdefghijklmnopqrstuvwxyz 0123456789 []{}<>/\\#@%&*+=~`
        ].join('\r\n')
      }).join('\r\n')
      return new Promise<void>((resolve) => {
        pane.terminal.write(`${burst}\r\n`, resolve)
      })
    },
    { tabId, marker }
  )
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
      const cellWidth = pane.terminal._core?._renderService?.dimensions?.css?.cell?.width ?? 0
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
  // Why: half-width bug paints content in only ~50% of the screen; rowRight
  // lags far behind screenRight when cols are stale.
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

  test('keeps full-width geometry after switching away and back', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const { firstTabId, secondTabId } = await ensureTwoTerminalTabs(orcaPage)
    await forceWebglOnActiveTab(orcaPage)

    const runId = `${Date.now()}`
    const marker = `${TAB_SWITCH_MARKER_PREFIX}_${runId}`
    const firstPtyId = await waitForPanePtyIdOnTab(orcaPage, firstTabId)
    await writeStaticTabContent(orcaPage, firstTabId, marker, TAB_A_GLYPH_ROW)

    const baseline = await readTabTerminalGeometry(orcaPage, firstTabId, runId)
    expect(baseline.markerPresent).toBe(true)
    expect(baseline.overlayWidth).toBeGreaterThan(300)
    expect(geometryLooksCorrupted(baseline)).toBeNull()

    const corruptionReports: string[] = []
    await resetTerminalOutputSchedulerDebug(orcaPage)
    await startHiddenPtyOutputBurst(orcaPage, firstPtyId, runId)

    for (let cycle = 0; cycle < 12; cycle += 1) {
      await activateTerminalTab(orcaPage, secondTabId)
      await injectHiddenStreamingBurst(orcaPage, firstTabId, runId)
      // Why: rapid back-to-back switches mirror the user's leave/return pattern
      // and race the overlay's rAF/50ms refit retries.
      await activateTerminalTab(orcaPage, firstTabId)
      if (cycle % 3 === 0) {
        await activateTerminalTab(orcaPage, secondTabId)
        await activateTerminalTab(orcaPage, firstTabId)
      }

      // Sample immediately — bug often shows before the 50ms overlay refit retry.
      const immediate = await readTabTerminalGeometry(orcaPage, firstTabId, runId)
      const immediateIssue = geometryLooksCorrupted(immediate)
      if (immediateIssue) {
        corruptionReports.push(`cycle ${cycle} immediate: ${immediateIssue}`)
        await captureTabScreenshot(
          orcaPage,
          firstTabId,
          testInfo,
          `tab-switch-corrupt-immediate-cycle-${cycle}`
        )
      }

      await orcaPage.waitForTimeout(60)
      const settled = await readTabTerminalGeometry(orcaPage, firstTabId, runId)
      const settledIssue = geometryLooksCorrupted(settled)
      if (settledIssue) {
        corruptionReports.push(`cycle ${cycle} settled: ${settledIssue}`)
        await captureTabScreenshot(
          orcaPage,
          firstTabId,
          testInfo,
          `tab-switch-corrupt-settled-cycle-${cycle}`
        )
      }
    }
    const schedulerActivity = await waitForHiddenOutputSchedulerActivity(orcaPage)
    expect(schedulerActivity.scheduledDrainCount).toBeGreaterThan(0)

    if (corruptionReports.length > 0) {
      console.log('[tab-switch-repro] corruption reports:', corruptionReports)
    }

    expect(
      corruptionReports,
      corruptionReports.length > 0
        ? `tab switch left stale terminal geometry:\n${corruptionReports.join('\n')}`
        : undefined
    ).toEqual([])
  })

  test('keeps geometry after hidden alt-screen TUI redraws during tab switches', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const { firstTabId, secondTabId } = await ensureTwoTerminalTabs(orcaPage)
    await forceWebglOnActiveTab(orcaPage)

    const runId = `${Date.now()}`
    const finalMarker = `${TAB_SWITCH_MARKER_PREFIX}_${runId}_ALT_24`

    await orcaPage.evaluate(
      ({ tabId, finalMarker }) => {
        const manager = window.__paneManagers?.get(tabId)
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
        if (!pane) {
          throw new Error(`No terminal pane for tab ${tabId}`)
        }
        const frames = Array.from({ length: 25 }, (_, frame) => {
          const progress = `${'█'.repeat((frame % 8) + 1)}${'░'.repeat(8 - ((frame % 8) + 1))}`
          return [
            '\x1b[?2026h',
            '\x1b[?1049h',
            '\x1b[2J\x1b[H',
            '\x1b[?25l',
            `╭────────────────────────────────────────────────────────────────────╮`,
            `│ ${finalMarker} frame ${String(frame).padStart(3, '0')} ${progress}                     │`,
            `│ Dimension              │ Rating                                      │`,
            `╰────────────────────────────────────────────────────────────────────╯`,
            '\x1b[?2026l'
          ].join('\r\n')
        }).join('')
        return new Promise<void>((resolve) => pane.terminal.write(frames, resolve))
      },
      { tabId: firstTabId, finalMarker }
    )

    const corruptionReports: string[] = []
    for (let cycle = 0; cycle < 6; cycle += 1) {
      await activateTerminalTab(orcaPage, secondTabId)
      await orcaPage.evaluate(
        ({ tabId, finalMarker, cycle }) => {
          const manager = window.__paneManagers?.get(tabId)
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
          if (!pane) {
            throw new Error(`No terminal pane for tab ${tabId}`)
          }
          const frame = cycle * 4
          const progress = `${'█'.repeat((frame % 8) + 1)}${'░'.repeat(8 - ((frame % 8) + 1))}`
          const redraw = [
            '\x1b[?2026h',
            '\x1b[?1049h',
            '\x1b[2J\x1b[H',
            '\x1b[?25l',
            `╭────────────────────────────────────────────────────────────────────╮`,
            `│ ${finalMarker} frame ${String(frame).padStart(3, '0')} ${progress}                     │`,
            `│ Dimension              │ Rating                                      │`,
            `╰────────────────────────────────────────────────────────────────────╯`,
            '\x1b[?2026l'
          ].join('\r\n')
          return new Promise<void>((resolve) => pane.terminal.write(redraw, resolve))
        },
        { tabId: firstTabId, finalMarker, cycle }
      )
      await activateTerminalTab(orcaPage, firstTabId)

      const geometry = await readTabTerminalGeometry(orcaPage, firstTabId, `${runId}_ALT`)
      const issue = geometryLooksCorrupted(geometry)
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

    expect(
      corruptionReports,
      corruptionReports.length > 0
        ? `alt-screen hidden redraw left corrupted geometry:\n${corruptionReports.join('\n')}`
        : undefined
    ).toEqual([])
  })

  test('restores skipped hidden agent output on light tab resume', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const shellTabId = (await getActiveTabId(orcaPage))!
    const agentTabId = await createCodexMarkedTerminalTab(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPanePtyIdOnTab(orcaPage, agentTabId)
    const paneIdentity = await readPaneIdentityOnTab(orcaPage, agentTabId)
    const paneKey = `${agentTabId}:${paneIdentity.leafId}`

    await activateTerminalTab(orcaPage, shellTabId)
    const runId = `${Date.now()}`
    const marker = `${TAB_SWITCH_MARKER_PREFIX}_SKIPPED_AGENT_${runId}`
    const hiddenFrame = [
      '\x1b[?2026h',
      `${marker} hidden renderer frame`,
      'status=streaming while tab-hidden',
      '\x1b[?2026l'
    ].join('\r\n')
    await resetHiddenOutputDebug(orcaPage)
    await injectPaneData(orcaPage, paneKey, hiddenFrame, {
      seq: hiddenFrame.length,
      rawLength: hiddenFrame.length
    })

    await expect
      .poll(async () => (await readHiddenOutputDebug(orcaPage))?.hiddenRendererSkipCount ?? 0, {
        timeout: 5_000,
        message: 'Codex-marked hidden output did not take the skipped renderer path'
      })
      .toBeGreaterThan(0)
    await setHiddenSnapshotOverride(orcaPage, paneIdentity.ptyId, {
      data: `${marker} restored from main snapshot\r\n`,
      cols: paneIdentity.cols,
      rows: paneIdentity.rows,
      seq: hiddenFrame.length
    })

    await activateTerminalTab(orcaPage, agentTabId)

    await expect
      .poll(() => getTerminalContent(orcaPage, 8_000), {
        timeout: 10_000,
        message: 'light tab resume did not request skipped hidden-output recovery'
      })
      .toContain(marker)
  })

  test('restores skipped hidden Grok output on light tab resume', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const shellTabId = (await getActiveTabId(orcaPage))!
    const grokTabId = await createGrokMarkedTerminalTab(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPanePtyIdOnTab(orcaPage, grokTabId)
    const paneIdentity = await readPaneIdentityOnTab(orcaPage, grokTabId)
    const paneKey = `${grokTabId}:${paneIdentity.leafId}`

    await activateTerminalTab(orcaPage, shellTabId)
    const runId = `${Date.now()}`
    const marker = `${TAB_SWITCH_MARKER_PREFIX}_SKIPPED_GROK_${runId}`
    // Why: synchronized-output mode exercises the hidden renderer skip path
    // used by agent TUIs before light tab resume requests recovery.
    const hiddenFrame = [
      '\x1b[?2026h',
      `${marker} hidden renderer frame`,
      'status=streaming while tab-hidden',
      '\x1b[?2026l'
    ].join('\r\n')
    await resetHiddenOutputDebug(orcaPage)
    await injectPaneData(orcaPage, paneKey, hiddenFrame, {
      seq: hiddenFrame.length,
      rawLength: hiddenFrame.length
    })

    await expect
      .poll(async () => (await readHiddenOutputDebug(orcaPage))?.hiddenRendererSkipCount ?? 0, {
        timeout: 5_000,
        message: 'Grok-marked hidden output did not take the skipped renderer path'
      })
      .toBeGreaterThan(0)
    await setHiddenSnapshotOverride(orcaPage, paneIdentity.ptyId, {
      data: `${marker} restored from main snapshot\r\n`,
      cols: paneIdentity.cols,
      rows: paneIdentity.rows,
      seq: hiddenFrame.length
    })

    await activateTerminalTab(orcaPage, grokTabId)

    await expect
      .poll(() => getTerminalContent(orcaPage, 8_000), {
        timeout: 10_000,
        message: 'light tab resume did not request skipped Grok hidden-output recovery'
      })
      .toContain(marker)
  })

  test('keeps returned tab glyphs intact across tab switches', async ({ orcaPage }, testInfo) => {
    // Why: screenshot equality catches WebGL atlas corruption on the tab being
    // resumed, not just stale cols/rows geometry checks.
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
      // Why: do not write into the hidden tab here — new bytes would change the
      // screenshot even when rendering is healthy. This cycle only exercises the
      // suspend/resume + atlas reset path on unchanged content.
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
