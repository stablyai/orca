import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { sendToTerminal, waitForActivePanePtyId } from './helpers/terminal'
import { compareTerminalScreenshots } from './terminal-screenshot-diff'

// Mirror FLOATING_TERMINAL_WORKTREE_ID without loading renderer/shared modules into Playwright.
const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const PANEL_SELECTOR = '[data-floating-terminal-panel]'

// Dispatch the same toggle event as the status bar and shortcut.
const TOGGLE_EVENT = 'orca-toggle-floating-terminal'

// Block shell prompt repaints so screenshot comparisons stay stable.
const SILENT_FOREGROUND_COMMAND = 'node -e "setInterval(() => {}, 1000)"\r'

// Use distinct glyph populations so shared-page refills invalidate stale coordinates visibly.
const WORKSPACE_GLYPH_ROW = 'abcdefghijklmnopqrstuvwxyz 0123456789 []{}<>/\\#@%&*+=~'
const FLOATING_GLYPH_ROW = 'ZYXWVUTSRQPONMLKJIHGFEDCBA 9876543210 !?^"\'();:,.|$_-'

async function dumpFloatingDiagnostics(page: Page, label: string): Promise<void> {
  const probe = await page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    const tabs = state?.tabsByWorktree?.[worktreeId] ?? []
    return tabs.map((tab) => ({
      tabId: tab.id,
      diagnostics: window.__paneManagers?.get(tab.id)?.getRenderingDiagnostics?.() ?? null
    }))
  }, FLOATING_WORKTREE_ID)
  console.log(`[shared-atlas] ${label}: ${JSON.stringify(probe)}`)
}

async function setSharedAtlasSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    const state = store?.getState()
    if (!store || !state?.settings) {
      throw new Error('Store unavailable')
    }
    store.setState({
      settings: {
        ...state.settings,
        floatingTerminalEnabled: true,
        terminalGpuAcceleration: 'on'
      }
    })
  })
}

async function ensureFloatingTabs(page: Page, count: number): Promise<string[]> {
  const tabIds = await page.evaluate(
    ({ worktreeId, wanted }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      while ((store.getState().tabsByWorktree[worktreeId] ?? []).length < wanted) {
        store.getState().createTab(worktreeId, undefined, undefined, { activate: false })
      }
      const tabs = store.getState().tabsByWorktree[worktreeId] ?? []
      store.getState().activateTab(tabs[0].id)
      return tabs.slice(0, wanted).map((tab) => tab.id)
    },
    { worktreeId: FLOATING_WORKTREE_ID, wanted: count }
  )
  // Wait for React’s enabled-state commit or the closure-backed toggle drops the event.
  await page.waitForFunction(
    (panelSelector) => Boolean(document.querySelector(panelSelector)),
    PANEL_SELECTOR,
    { timeout: 30_000 }
  )
  return tabIds
}

async function activateFloatingTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    window.__store?.getState().activateTab(id)
  }, tabId)
}

async function toggleFloatingPanel(page: Page, open: boolean): Promise<void> {
  await page.evaluate((eventName) => {
    window.dispatchEvent(new Event(eventName))
  }, TOGGLE_EVENT)
  await (open
    ? expect(page.locator(PANEL_SELECTOR)).toBeVisible()
    : expect(page.locator(PANEL_SELECTOR)).toBeHidden())
}

async function waitForWebglOnTab(page: Page, tabId: string): Promise<boolean> {
  // Force GPU attachment when the pane mounted before its setting committed.
  await page.evaluate((id) => {
    window.__paneManagers?.get(id)?.setTerminalGpuAcceleration?.('on')
  }, tabId)
  // Use supported rendering diagnostics; public pane projections omit webglAddon.
  return page
    .waitForFunction(
      (id) => {
        const diagnostics = window.__paneManagers?.get(id)?.getRenderingDiagnostics?.() ?? []
        return diagnostics.some((diagnostic) => diagnostic.hasWebgl)
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

async function writeStaticContent(
  page: Page,
  tabId: string,
  marker: string,
  glyphRow: string
): Promise<void> {
  await page.evaluate(
    async ({ id, content }) => {
      const manager = window.__paneManagers?.get(id)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!pane) {
        throw new Error(`Pane unavailable for tab ${id}`)
      }
      await new Promise<void>((resolve) => pane.terminal.write(content, resolve))
    },
    {
      id: tabId,
      // Use stable default-colored ASCII: atlas page merges can clear stale models and accidentally hide corruption.
      content: `\x1b[2J\x1b[3J\x1b[H\x1b[?25l${Array.from(
        { length: 14 },
        (_, row) => `${marker} row ${row} | ${glyphRow} |\r\n`
      ).join('')}`
    }
  )
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
}

async function refreshTerminalOnTab(page: Page, tabId: string): Promise<void> {
  // Force the repaint an active agent would produce or stale-model corruption stays latent.
  await page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    for (const pane of manager?.getPanes?.() ?? []) {
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    }
  }, tabId)
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
}

// Identical font settings share xterm’s module-global atlas; confirm that precondition before testing cross-terminal corruption.
async function tabsShareGlyphAtlas(page: Page, tabIdA: string, tabIdB: string): Promise<boolean> {
  return page.evaluate(
    ({ a, b }) => {
      const atlasCanvasOf = (tabId: string): HTMLCanvasElement | null => {
        const manager = window.__paneManagers?.get(tabId)
        // Compare internal addon atlas identity because public pane projections omit webglAddon.
        const internalPanes = (
          manager as unknown as
            | { panes?: Map<number, { webglAddon?: { textureAtlas?: HTMLCanvasElement } | null }> }
            | undefined
        )?.panes
        const pane = internalPanes ? [...internalPanes.values()][0] : undefined
        return pane?.webglAddon?.textureAtlas ?? null
      }
      const atlasA = atlasCanvasOf(a)
      return Boolean(atlasA) && atlasA === atlasCanvasOf(b)
    },
    { a: tabIdA, b: tabIdB }
  )
}

async function resetAtlasOnTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    window.__paneManagers?.get(id)?.resetWebglTextureAtlases?.()
  }, tabId)
}

function workspaceScreenLocator(page: Page, ptyId: string): ReturnType<Page['locator']> {
  return page.locator(`[data-pty-id="${ptyId}"] .xterm-screen`).first()
}

async function screenshotWorkspaceTerminal(page: Page, ptyId: string): Promise<Buffer> {
  const screen = workspaceScreenLocator(page, ptyId)
  await expect(screen).toBeVisible()
  return screen.screenshot({ animations: 'disabled' })
}

async function captureStableWorkspaceShot(page: Page, ptyId: string): Promise<Buffer> {
  // Require consecutive identical captures before screenshot comparisons.
  let previous = await screenshotWorkspaceTerminal(page, ptyId)
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.waitForTimeout(250)
    const next = await screenshotWorkspaceTerminal(page, ptyId)
    if (next.equals(previous)) {
      return next
    }
    previous = next
  }
  throw new Error('Workspace terminal surface did not stabilize for a screenshot')
}

async function settleAtlasActivity(page: Page): Promise<void> {
  // Outwait idle atlas warmup and the 500ms delayed recovery resets.
  await page.waitForTimeout(800)
}

type SharedAtlasScenario = {
  workspaceTabId: string
  workspacePtyId: string
  floatingTabIds: string[]
  baseline: Buffer
}

// Stage a stable workspace plus two floating tabs sharing its atlas; capture with the overlay closed.
async function setUpSharedAtlasScenario(page: Page): Promise<SharedAtlasScenario | null> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await setSharedAtlasSettings(page)

  const workspaceTabId = await page.evaluate(() => {
    const state = window.__store?.getState()
    return state?.activeTabId ?? null
  })
  if (!workspaceTabId) {
    return null
  }
  const workspacePtyId = await waitForActivePanePtyId(page)
  if (!(await waitForWebglOnTab(page, workspaceTabId))) {
    console.log('[shared-atlas] workspace terminal never attached WebGL')
    return null
  }
  await sendToTerminal(page, workspacePtyId, SILENT_FOREGROUND_COMMAND)
  // Let the foreground command block before clearing; later captures explicitly prove stability.
  await page.waitForTimeout(1_000)
  await writeStaticContent(page, workspaceTabId, 'WORKSPACE', WORKSPACE_GLYPH_ROW)

  const floatingTabIds = await ensureFloatingTabs(page, 2)
  await toggleFloatingPanel(page, true)
  if (!(await waitForWebglOnTab(page, floatingTabIds[0]))) {
    await dumpFloatingDiagnostics(page, 'active floating tab never attached WebGL')
    return null
  }
  for (const tabId of floatingTabIds) {
    const ptyId = await waitForPanePtyIdOnTab(page, tabId)
    await sendToTerminal(page, ptyId, SILENT_FOREGROUND_COMMAND)
  }
  await page.waitForTimeout(1_000)
  // Hidden tabs refill cleared shared pages on resume with a different glyph layout.
  for (const tabId of floatingTabIds) {
    await writeStaticContent(page, tabId, 'FLOATING', FLOATING_GLYPH_ROW)
  }

  if (!(await tabsShareGlyphAtlas(page, workspaceTabId, floatingTabIds[0]))) {
    console.log('[shared-atlas] workspace and floating terminals do not share an atlas')
    return null
  }

  // Rebuild after fonts settle so later re-rasterization matches the baseline.
  await resetAtlasOnTab(page, workspaceTabId)
  await settleAtlasActivity(page)

  // Close the overlay for workspace screenshots; suspension alone does not mutate the atlas.
  await toggleFloatingPanel(page, false)
  // Rebuild after close-triggered refit so baseline and post-trigger model state agree.
  await resetAtlasOnTab(page, workspaceTabId)
  const baseline = await captureStableWorkspaceShot(page, workspacePtyId)

  return { workspaceTabId, workspacePtyId, floatingTabIds, baseline }
}

async function captureWorkspaceAfterTrigger(
  page: Page,
  scenario: SharedAtlasScenario
): Promise<Buffer> {
  await settleAtlasActivity(page)
  // Force the full repaint a live agent would produce before comparing.
  await refreshTerminalOnTab(page, scenario.workspaceTabId)
  return captureStableWorkspaceShot(page, scenario.workspacePtyId)
}

test.describe('floating workspace shared glyph atlas @headful', () => {
  test('switching floating workspace tabs keeps workspace terminal glyphs intact', async ({
    orcaPage
  }, testInfo) => {
    // Resuming a floating renderer clears shared atlas pages; sibling models must invalidate their old glyph coordinates.
    const scenario = await setUpSharedAtlasScenario(orcaPage)
    test.skip(!scenario, 'WebGL inactive or terminals do not share a glyph atlas')
    const { baseline, floatingTabIds } = scenario!

    await toggleFloatingPanel(orcaPage, true)
    await activateFloatingTab(orcaPage, floatingTabIds[1])
    // Require WebGL attachment to prove the tab switch actually resumed rendering.
    expect(
      await waitForWebglOnTab(orcaPage, floatingTabIds[1]),
      'switched-to floating tab should resume WebGL'
    ).toBe(true)
    await settleAtlasActivity(orcaPage)
    await toggleFloatingPanel(orcaPage, false)

    const afterSwitch = await captureWorkspaceAfterTrigger(orcaPage, scenario!)
    await testInfo.attach('baseline', { body: baseline, contentType: 'image/png' })
    await testInfo.attach('after-tab-switch', { body: afterSwitch, contentType: 'image/png' })
    // Allow antialiasing noise below 1.5%; stale-model blanking affects ~3% of pixels.
    const afterSwitchDiff = compareTerminalScreenshots(baseline, afterSwitch)
    console.log(
      `[shared-atlas] tabSwitchIntact=${afterSwitchDiff.matches} diffRatio=${afterSwitchDiff.diffRatio.toFixed(5)} diffPixels=${afterSwitchDiff.diffPixels}`
    )

    expect(
      afterSwitchDiff.matches,
      'workspace terminal must render identically after floating tab switching'
    ).toBe(true)
  })

  test('a sibling terminal clearing the shared atlas leaves workspace glyphs intact', async ({
    orcaPage
  }, testInfo) => {
    // Clear the floating manager directly: reveal’s global reset would heal every pane and mask missing sibling invalidation.
    const scenario = await setUpSharedAtlasScenario(orcaPage)
    test.skip(!scenario, 'WebGL inactive or terminals do not share a glyph atlas')
    const { baseline, workspacePtyId, floatingTabIds } = scenario!

    // The panel stays closed: the workspace terminal must be the only thing repainting.
    await resetAtlasOnTab(orcaPage, floatingTabIds[0])

    // Refresh without rebuilding to exercise vertices still pointing into the wiped atlas.
    await refreshTerminalOnTab(orcaPage, scenario!.workspaceTabId)
    const afterSiblingClear = await captureStableWorkspaceShot(orcaPage, workspacePtyId)

    await testInfo.attach('baseline', { body: baseline, contentType: 'image/png' })
    await testInfo.attach('after-sibling-clear', {
      body: afterSiblingClear,
      contentType: 'image/png'
    })
    const afterSiblingClearDiff = compareTerminalScreenshots(baseline, afterSiblingClear)
    console.log(
      `[shared-atlas] siblingClearIntact=${afterSiblingClearDiff.matches} diffRatio=${afterSiblingClearDiff.diffRatio.toFixed(5)} diffPixels=${afterSiblingClearDiff.diffPixels}`
    )

    expect(
      afterSiblingClearDiff.matches,
      'workspace terminal must rebuild its model after a sibling wipes the shared atlas'
    ).toBe(true)
  })

  test('reopening the floating workspace keeps workspace terminal glyphs intact', async ({
    orcaPage
  }, testInfo) => {
    // Panel reopen also resumes a renderer and clears shared pages, so siblings must invalidate then too.
    const scenario = await setUpSharedAtlasScenario(orcaPage)
    test.skip(!scenario, 'WebGL inactive or terminals do not share a glyph atlas')
    const { baseline } = scenario!

    await toggleFloatingPanel(orcaPage, true)
    await settleAtlasActivity(orcaPage)
    await toggleFloatingPanel(orcaPage, false)

    const afterReopen = await captureWorkspaceAfterTrigger(orcaPage, scenario!)
    await testInfo.attach('baseline', { body: baseline, contentType: 'image/png' })
    await testInfo.attach('after-reopen', { body: afterReopen, contentType: 'image/png' })
    const afterReopenDiff = compareTerminalScreenshots(baseline, afterReopen)
    console.log(
      `[shared-atlas] reopenIntact=${afterReopenDiff.matches} diffRatio=${afterReopenDiff.diffRatio.toFixed(5)} diffPixels=${afterReopenDiff.diffPixels}`
    )

    expect(
      afterReopenDiff.matches,
      'workspace terminal must render identically after a floating panel reopen'
    ).toBe(true)
  })
})
