import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { sendToTerminal } from './helpers/terminal'

// Mirror FLOATING_TERMINAL_WORKTREE_ID without loading renderer/shared modules into Playwright.
const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const PANEL_SELECTOR = '[data-floating-terminal-panel]'

// Dispatch the same toggle event as the status bar and shortcut.
const TOGGLE_EVENT = 'orca-toggle-floating-terminal'

// Block shell prompt repaints so screenshot comparisons stay stable.
const SILENT_FOREGROUND_COMMAND = 'node -e "setInterval(() => {}, 1000)"\r'

// Keep probe counters local; global Window augmentation would leak into every spec.
type RecoveryCounterWindow = typeof window & {
  __floatingManagerResets?: number
  __floatingRenderResumes?: number
}

async function enableFloatingWorkspaceWithWebgl(page: Page): Promise<void> {
  await page.evaluate((worktreeId) => {
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
    const tabs = store.getState().tabsByWorktree[worktreeId] ?? []
    if (tabs.length === 0) {
      const tab = store.getState().createTab(worktreeId, undefined, undefined, {
        activate: false
      })
      store.getState().activateTab(tab.id)
    }
  }, FLOATING_WORKTREE_ID)
  // Wait for React’s enabled-state commit or the closure-backed toggle drops the event.
  await page.waitForFunction(
    (panelSelector) => Boolean(document.querySelector(panelSelector)),
    PANEL_SELECTOR,
    { timeout: 30_000 }
  )
}

async function waitForFloatingPanePtyId(page: Page): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate((worktreeId) => {
          const state = window.__store?.getState()
          const tab = (state?.tabsByWorktree?.[worktreeId] ?? [])[0]
          const manager = tab ? window.__paneManagers?.get(tab.id) : null
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return pane?.container?.dataset?.ptyId ?? null
        }, FLOATING_WORKTREE_ID),
      {
        timeout: 15_000,
        message: 'Floating terminal pane did not receive a PTY binding'
      }
    )
    .not.toBeNull()
  const ptyId = await page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    const tab = (state?.tabsByWorktree?.[worktreeId] ?? [])[0]
    const manager = tab ? window.__paneManagers?.get(tab.id) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return pane?.container?.dataset?.ptyId ?? null
  }, FLOATING_WORKTREE_ID)
  if (!ptyId) {
    throw new Error('Floating terminal pane has no PTY binding')
  }
  return ptyId
}

async function toggleFloatingPanel(page: Page, open: boolean): Promise<void> {
  await page.evaluate((eventName) => {
    window.dispatchEvent(new Event(eventName))
  }, TOGGLE_EVENT)
  await (open
    ? expect(page.locator(PANEL_SELECTOR)).toBeVisible()
    : expect(page.locator(PANEL_SELECTOR)).toBeHidden())
}

async function waitForFloatingWebglPane(page: Page): Promise<boolean> {
  // Force GPU attachment when the pane mounted before its setting committed.
  await page
    .waitForFunction(
      (worktreeId) => {
        const state = window.__store?.getState()
        const tab = (state?.tabsByWorktree?.[worktreeId] ?? [])[0]
        const manager = tab ? window.__paneManagers?.get(tab.id) : null
        return Boolean(manager?.getActivePane?.() ?? manager?.getPanes?.()[0])
      },
      FLOATING_WORKTREE_ID,
      { timeout: 15_000 }
    )
    .catch(() => undefined)
  await page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    const tab = (state?.tabsByWorktree?.[worktreeId] ?? [])[0]
    const manager = tab ? window.__paneManagers?.get(tab.id) : null
    manager?.setTerminalGpuAcceleration?.('on')
  }, FLOATING_WORKTREE_ID)
  // Use supported rendering diagnostics; public pane projections omit webglAddon.
  const attached = await page
    .waitForFunction(
      (worktreeId) => {
        const state = window.__store?.getState()
        const tab = (state?.tabsByWorktree?.[worktreeId] ?? [])[0]
        const manager = tab ? window.__paneManagers?.get(tab.id) : null
        const diagnostics = manager?.getRenderingDiagnostics?.() ?? []
        return diagnostics.some((diagnostic) => diagnostic.hasWebgl)
      },
      FLOATING_WORKTREE_ID,
      { timeout: 10_000 }
    )
    .then(() => true)
    .catch(() => false)
  if (!attached) {
    const probe = await page.evaluate((worktreeId) => {
      const state = window.__store?.getState()
      const tabs = state?.tabsByWorktree?.[worktreeId] ?? []
      const tab = tabs[0]
      const manager = tab ? window.__paneManagers?.get(tab.id) : null
      return {
        tabCount: tabs.length,
        hasManager: Boolean(manager),
        diagnostics: manager?.getRenderingDiagnostics?.() ?? null,
        gpuSetting: state?.settings?.terminalGpuAcceleration ?? null
      }
    }, FLOATING_WORKTREE_ID)
    console.log(`[floating-harness] webgl attach failed: ${JSON.stringify(probe)}`)
  }
  return attached
}

async function writeStaticContent(page: Page, marker: string): Promise<void> {
  await page.evaluate(
    async ({ worktreeId, content }) => {
      const state = window.__store?.getState()
      const tab = (state?.tabsByWorktree?.[worktreeId] ?? [])[0]
      const manager = tab ? window.__paneManagers?.get(tab.id) : null
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!pane) {
        throw new Error('Floating pane unavailable')
      }
      await new Promise<void>((resolve) => pane.terminal.write(content, resolve))
    },
    {
      worktreeId: FLOATING_WORKTREE_ID,
      // Clear screen/history and hide the cursor, then populate the atlas with stable dense glyphs.
      content: `\x1b[2J\x1b[3J\x1b[H\x1b[?25l${Array.from(
        { length: 14 },
        (_, row) =>
          `${marker} row ${row} | abcdefghijklmnopqrstuvwxyz 0123456789 []{}<>/\\#@%&*+=~ |\r\n`
      ).join('')}`
    }
  )
  // Wait for xterm paint before capturing the baseline.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
}

// Corrupt live atlas textures without context loss to reproduce silent Chromium glyph corruption (#5042).
async function corruptFloatingAtlas(page: Page): Promise<number> {
  return page.evaluate(
    ({ worktreeId, panelSelector }) => {
      const state = window.__store?.getState()
      const tab = (state?.tabsByWorktree?.[worktreeId] ?? [])[0]
      const manager = tab ? window.__paneManagers?.get(tab.id) : null
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!pane) {
        return 0
      }
      const panel = document.querySelector(panelSelector)
      const canvases = panel ? Array.from(panel.querySelectorAll('canvas')) : []
      const noise = new Uint8Array(64 * 64 * 4)
      for (let i = 0; i < noise.length; i += 4) {
        noise[i] = (i * 7) % 256
        noise[i + 1] = (i * 13) % 256
        noise[i + 2] = (i * 29) % 256
        noise[i + 3] = 255
      }
      let corrupted = 0
      for (const canvas of canvases) {
        const gl =
          (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
          (canvas.getContext('webgl') as WebGLRenderingContext | null)
        if (!gl) {
          continue
        }
        const maxUnits = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number
        for (let unit = 0; unit < maxUnits; unit += 1) {
          gl.activeTexture(gl.TEXTURE0 + unit)
          const bound = gl.getParameter(gl.TEXTURE_BINDING_2D)
          if (!bound) {
            continue
          }
          // Corrupt the top-left atlas region where glyph allocation begins.
          for (const [x, y] of [
            [0, 0],
            [64, 0],
            [128, 0],
            [192, 0],
            [0, 64],
            [64, 64],
            [128, 64],
            [192, 64]
          ]) {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, noise)
            if (gl.getError() === gl.NO_ERROR) {
              corrupted += 1
            }
          }
        }
        gl.activeTexture(gl.TEXTURE0)
      }
      pane.terminal.refresh(0, pane.terminal.rows - 1)
      return corrupted
    },
    { worktreeId: FLOATING_WORKTREE_ID, panelSelector: PANEL_SELECTOR }
  )
}

async function instrumentRecoveryCounters(page: Page): Promise<boolean> {
  return page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    const tab = (state?.tabsByWorktree?.[worktreeId] ?? [])[0]
    const manager = tab ? window.__paneManagers?.get(tab.id) : null
    if (!manager?.resetWebglTextureAtlases || !manager.resumeRendering) {
      return false
    }
    const counterWindow = window as RecoveryCounterWindow
    counterWindow.__floatingManagerResets = 0
    counterWindow.__floatingRenderResumes = 0
    const originalReset = manager.resetWebglTextureAtlases.bind(manager)
    manager.resetWebglTextureAtlases = () => {
      counterWindow.__floatingManagerResets = (counterWindow.__floatingManagerResets ?? 0) + 1
      originalReset()
    }
    // Count resumeRendering recovery too because suspend/resume also rebuilds the atlas.
    const originalResume = manager.resumeRendering.bind(manager)
    manager.resumeRendering = () => {
      counterWindow.__floatingRenderResumes = (counterWindow.__floatingRenderResumes ?? 0) + 1
      originalResume()
    }
    return true
  }, FLOATING_WORKTREE_ID)
}

async function readRecoveryCounters(
  page: Page
): Promise<{ managerResets: number; renderResumes: number }> {
  return page.evaluate(() => {
    const counterWindow = window as RecoveryCounterWindow
    return {
      managerResets: counterWindow.__floatingManagerResets ?? 0,
      renderResumes: counterWindow.__floatingRenderResumes ?? 0
    }
  })
}

async function screenshotFloatingTerminal(page: Page): Promise<Buffer> {
  const screen = page.locator(`${PANEL_SELECTOR} .xterm-screen`).first()
  await expect(screen).toBeVisible()
  return screen.screenshot({ animations: 'disabled' })
}

async function settleRecoveryWindows(page: Page): Promise<void> {
  // Outwait the 500ms delayed resets so no-recovery assertions cannot race pending work.
  await page.waitForTimeout(800)
}

async function captureStableBaseline(page: Page): Promise<Buffer> {
  // Require consecutive identical screenshots before comparing corruption or healing.
  let previous = await screenshotFloatingTerminal(page)
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.waitForTimeout(250)
    const next = await screenshotFloatingTerminal(page)
    if (next.equals(previous)) {
      return next
    }
    previous = next
  }
  throw new Error('Floating terminal surface did not stabilize for a baseline screenshot')
}

async function setUpCorruptedFloatingTerminal(
  page: Page,
  marker: string
): Promise<{ baseline: Buffer; corrupted: Buffer } | null> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await enableFloatingWorkspaceWithWebgl(page)
  await toggleFloatingPanel(page, true)
  if (!(await waitForFloatingWebglPane(page))) {
    return null
  }
  const ptyId = await waitForFloatingPanePtyId(page)
  await sendToTerminal(page, ptyId, SILENT_FOREGROUND_COMMAND)
  // Let the foreground command block before clearing; later captures explicitly prove stability.
  await page.waitForTimeout(1_000)
  await writeStaticContent(page, marker)
  // Rebuild after fonts settle so baseline and recovered glyph rasterization can match exactly.
  await page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    const tab = (state?.tabsByWorktree?.[worktreeId] ?? [])[0]
    const manager = tab ? window.__paneManagers?.get(tab.id) : null
    manager?.resetWebglTextureAtlases?.()
  }, FLOATING_WORKTREE_ID)
  const baseline = await captureStableBaseline(page)
  const corruptedTiles = await corruptFloatingAtlas(page)
  console.log(`[floating-harness] corrupted atlas tiles: ${corruptedTiles}`)
  if (corruptedTiles === 0) {
    return null
  }
  // Wait for corrupted pixels to paint; skip if noise missed the active glyph region.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.waitForTimeout(250)
    const shot = await screenshotFloatingTerminal(page)
    if (!shot.equals(baseline)) {
      return { baseline, corrupted: shot }
    }
  }
  console.log('[floating-harness] injected atlas noise never became visible')
  return null
}

test.describe('floating workspace reopen WebGL recovery @headful', () => {
  test('reopening the floating workspace recovers a corrupted glyph atlas', async ({
    orcaPage
  }, testInfo) => {
    // Closing must suspend WebGL so reopen discards silently corrupted atlas state.
    const shots = await setUpCorruptedFloatingTerminal(orcaPage, 'REOPEN')
    test.skip(!shots, 'WebGL was not active or atlas corruption could not be injected')
    const { baseline, corrupted } = shots!
    expect(corrupted.equals(baseline)).toBe(false)

    expect(await instrumentRecoveryCounters(orcaPage)).toBe(true)

    await toggleFloatingPanel(orcaPage, false)
    // Hidden floating terminals must retain no live WebGL context to corrupt.
    const webglAttachedWhileClosed = await orcaPage.evaluate((worktreeId) => {
      const state = window.__store?.getState()
      const tab = (state?.tabsByWorktree?.[worktreeId] ?? [])[0]
      const manager = tab ? window.__paneManagers?.get(tab.id) : null
      const diagnostics = manager?.getRenderingDiagnostics?.() ?? []
      return diagnostics.some((diagnostic) => diagnostic.hasWebgl)
    }, FLOATING_WORKTREE_ID)
    expect(webglAttachedWhileClosed, 'closing the panel should suspend WebGL rendering').toBe(false)

    await toggleFloatingPanel(orcaPage, true)
    await settleRecoveryWindows(orcaPage)

    const counters = await readRecoveryCounters(orcaPage)
    const afterReopen = await screenshotFloatingTerminal(orcaPage)
    await testInfo.attach('baseline', {
      body: baseline,
      contentType: 'image/png'
    })
    await testInfo.attach('corrupted', {
      body: corrupted,
      contentType: 'image/png'
    })
    await testInfo.attach('after-reopen', {
      body: afterReopen,
      contentType: 'image/png'
    })
    console.log(
      `[floating-reopen] managerResets=${counters.managerResets} renderResumes=${counters.renderResumes} healed=${afterReopen.equals(baseline)}`
    )

    expect(
      counters.managerResets + counters.renderResumes,
      'reopen should reset or rebuild the corrupted atlas'
    ).toBeGreaterThan(0)
    expect(afterReopen.equals(baseline), 'reopened terminal should render clean glyphs').toBe(true)
  })

  test('system resume recovers the corrupted atlas (harness control)', async ({
    orcaPage,
    electronApp
  }) => {
    // Prove existing recovery heals this exact corruption so reopen failure cannot be blamed on the harness.
    const shots = await setUpCorruptedFloatingTerminal(orcaPage, 'CONTROL')
    test.skip(!shots, 'WebGL was not active or atlas corruption could not be injected')
    const { baseline, corrupted } = shots!
    expect(corrupted.equals(baseline)).toBe(false)

    await electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) {
        throw new Error('Orca window unavailable for system resume')
      }
      mainWindow.webContents.send('system:resumed')
    })
    await settleRecoveryWindows(orcaPage)

    const afterResume = await screenshotFloatingTerminal(orcaPage)
    console.log(`[floating-control] healedByResume=${afterResume.equals(baseline)}`)
    expect(afterResume.equals(baseline), 'system resume should heal the atlas').toBe(true)
  })
})
