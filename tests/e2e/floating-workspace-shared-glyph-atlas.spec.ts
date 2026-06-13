import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { sendToTerminal, waitForActivePanePtyId } from './helpers/terminal'

// Why: mirrors FLOATING_TERMINAL_WORKTREE_ID in src/shared/constants.ts.
// e2e specs avoid importing renderer/shared modules into the Playwright runner.
const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const PANEL_SELECTOR = '[data-floating-terminal-panel]'

// Why: the floating panel toggles via this window event
// (src/renderer/src/lib/floating-terminal.ts); dispatching it exercises the
// same code path as the status bar button and the keyboard shortcut.
const TOGGLE_EVENT = 'orca-toggle-floating-terminal'

// Why: a silent foreground command blocks the shell so no prompt framework
// (e.g. async p10k segments) repaints while screenshots are compared.
const SILENT_FOREGROUND_COMMAND = 'node -e "setInterval(() => {}, 1000)"\r'

// Why: distinct glyph populations per terminal. After a shared-atlas clear the
// pages refill in first-use order, so terminals with different content put
// different glyphs at the coordinates a stale render model still points to.
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
  // Why: the toggle event listener closes over floatingTerminalEnabled; wait
  // for the (lazy) panel to mount so React has committed the enabled state
  // before the toggle event is dispatched, otherwise the event is dropped.
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
  // Why: a pane that mounted before the GPU setting landed needs the manager
  // call too — mirrors forceWebgl in terminal-image-paste-webgl-recovery.spec.
  await page.evaluate((id) => {
    window.__paneManagers?.get(id)?.setTerminalGpuAcceleration?.('on')
  }, tabId)
  // Why: getPanes()/getActivePane() return a public projection without
  // webglAddon; getRenderingDiagnostics() is the supported way to observe
  // whether WebGL is attached.
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
      // Why: clear screen + scrollback and hide the cursor so screenshots are
      // time-invariant, then render dense mixed glyphs so the shared WebGL
      // atlas region this terminal depends on is populated. Default-colored
      // ASCII only: a small glyph population avoids atlas page merges, whose
      // one-shot clear-model flag would let a stale renderer accidentally
      // self-heal and mask the corruption this spec reproduces.
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
  // Why: stands in for the steady output stream of a real agent session. The
  // workspace shell is blocked, so without a repaint trigger the stale-model
  // corruption would stay latent and the comparison would prove nothing.
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

/**
 * True when both tabs' WebGL renderers draw from the same glyph texture atlas.
 * @xterm/addon-webgl keeps a module-global atlas cache keyed by font config,
 * so terminals with identical settings share pages — the precondition for the
 * cross-terminal corruption this spec reproduces.
 */
async function tabsShareGlyphAtlas(page: Page, tabIdA: string, tabIdB: string): Promise<boolean> {
  return page.evaluate(
    ({ a, b }) => {
      const atlasCanvasOf = (tabId: string): HTMLCanvasElement | null => {
        const manager = window.__paneManagers?.get(tabId)
        // Why: the public pane projection omits webglAddon; reach the internal
        // pane map (runtime-visible) to compare addon.textureAtlas identity.
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
  // Why: two consecutive identical captures prove the surface is byte-stable
  // before screenshot-equality comparisons begin.
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
  // Why: atlas warm-up re-rasterization runs in idle callbacks and scheduled
  // recovery resets fire up to 500ms after their trigger; wait past both.
  await page.waitForTimeout(800)
}

type SharedAtlasScenario = {
  workspaceTabId: string
  workspacePtyId: string
  floatingTabIds: string[]
  baseline: Buffer
}

/**
 * Stage: a visible workspace terminal with stable static content, plus two
 * floating workspace terminal tabs whose WebGL renderers share its glyph
 * atlas. Returns a workspace baseline screenshot taken with the panel closed
 * (the panel can overlap the workspace terminal region).
 */
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
  // Why: give the shell a beat to echo the command and start blocking before
  // the screen is cleared; later captures verify stability explicitly.
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
  // Why: the hidden second tab accepts writes too — its buffer paints on
  // resume, refilling the cleared shared atlas with a different glyph layout.
  for (const tabId of floatingTabIds) {
    await writeStaticContent(page, tabId, 'FLOATING', FLOATING_GLYPH_ROW)
  }

  if (!(await tabsShareGlyphAtlas(page, workspaceTabId, floatingTabIds[0]))) {
    console.log('[shared-atlas] workspace and floating terminals do not share an atlas')
    return null
  }

  // Why: glyphs rasterized during startup can predate web font readiness; a
  // clean rebuild here makes the baseline byte-identical to any later
  // re-rasterization, so equality is a sound "intact" oracle.
  await resetAtlasOnTab(page, workspaceTabId)
  await settleAtlasActivity(page)

  // Why: the panel overlay can cover the workspace terminal region, so all
  // workspace screenshots are taken with the panel closed. Closing only
  // suspends the floating renderer; it never mutates the shared atlas.
  await toggleFloatingPanel(page, false)
  // Why: closing the panel can refit the workspace terminal; rebuild once more
  // so the baseline model/atlas state matches the post-trigger capture path.
  await resetAtlasOnTab(page, workspaceTabId)
  const baseline = await captureStableWorkspaceShot(page, workspacePtyId)

  return { workspaceTabId, workspacePtyId, floatingTabIds, baseline }
}

async function captureWorkspaceAfterTrigger(
  page: Page,
  scenario: SharedAtlasScenario
): Promise<Buffer> {
  await settleAtlasActivity(page)
  // Why: a real agent session repaints continuously; the blocked test shell
  // does not, so force the equivalent full repaint before comparing.
  await refreshTerminalOnTab(page, scenario.workspaceTabId)
  return captureStableWorkspaceShot(page, scenario.workspacePtyId)
}

test.describe('floating workspace shared glyph atlas @headful', () => {
  test('switching floating workspace tabs keeps workspace terminal glyphs intact', async ({
    orcaPage
  }, testInfo) => {
    // Why: xterm WebGL terminals with identical font configs share one glyph
    // texture atlas. The floating tab switch resumes a hidden renderer, whose
    // atlas reset clears those shared pages; unless every sharing terminal
    // rebuilds its render model too, the visible workspace terminal keeps
    // stale glyph coordinates and paints garbage (the bug this guards).
    const scenario = await setUpSharedAtlasScenario(orcaPage)
    test.skip(!scenario, 'WebGL inactive or terminals do not share a glyph atlas')
    const { baseline, floatingTabIds } = scenario!

    await toggleFloatingPanel(orcaPage, true)
    await activateFloatingTab(orcaPage, floatingTabIds[1])
    // Why: the switched-to tab attaching WebGL proves the suspend/resume
    // (and with it the atlas reset trigger) actually ran.
    expect(
      await waitForWebglOnTab(orcaPage, floatingTabIds[1]),
      'switched-to floating tab should resume WebGL'
    ).toBe(true)
    await settleAtlasActivity(orcaPage)
    await toggleFloatingPanel(orcaPage, false)

    const afterSwitch = await captureWorkspaceAfterTrigger(orcaPage, scenario!)
    await testInfo.attach('baseline', { body: baseline, contentType: 'image/png' })
    await testInfo.attach('after-tab-switch', { body: afterSwitch, contentType: 'image/png' })
    console.log(`[shared-atlas] tabSwitchIntact=${afterSwitch.equals(baseline)}`)

    expect(
      afterSwitch.equals(baseline),
      'workspace terminal must render identically after floating tab switching'
    ).toBe(true)
  })

  test('reopening the floating workspace keeps workspace terminal glyphs intact', async ({
    orcaPage
  }, testInfo) => {
    // Why: reopening the panel resumes its terminal, whose atlas reset clears
    // the shared pages just like a tab switch — the other user flow that
    // garbled visible workspace terminals before resets went global.
    const scenario = await setUpSharedAtlasScenario(orcaPage)
    test.skip(!scenario, 'WebGL inactive or terminals do not share a glyph atlas')
    const { baseline } = scenario!

    await toggleFloatingPanel(orcaPage, true)
    await settleAtlasActivity(orcaPage)
    await toggleFloatingPanel(orcaPage, false)

    const afterReopen = await captureWorkspaceAfterTrigger(orcaPage, scenario!)
    await testInfo.attach('baseline', { body: baseline, contentType: 'image/png' })
    await testInfo.attach('after-reopen', { body: afterReopen, contentType: 'image/png' })
    console.log(`[shared-atlas] reopenIntact=${afterReopen.equals(baseline)}`)

    expect(
      afterReopen.equals(baseline),
      'workspace terminal must render identically after a floating panel reopen'
    ).toBe(true)
  })
})
