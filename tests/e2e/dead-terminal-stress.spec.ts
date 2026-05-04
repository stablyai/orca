/**
 * Aggressive stress tests for dead-terminal reproduction.
 *
 * These tests target specific failure vectors beyond the basic setup-split flow:
 * - Forced WebGL context loss (simulating Chromium memory pressure)
 * - Rapid switching during the ~200ms scheduleSplitScrollRestore window
 *
 * All tests require @headful mode for WebGL to be active.
 */

import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  switchToWorktree,
  ensureTerminalVisible
} from './helpers/store'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import {
  createAndActivateWorktreeWithSetup,
  removeWorktreeViaStore,
  waitForAllPanesToHaveContent
} from './helpers/dead-terminal'

const STRESS_ITERATIONS = 5

test.describe('Dead Terminal Stress @headful', () => {
  const createdWorktreeIds: string[] = []

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)

    await orcaPage.evaluate(async () => {
      const state = window.__store?.getState()
      if (!state) {
        return
      }
      state.updateSettings({ setupScriptLaunchMode: 'split-vertical' })

      const wt = Object.values(state.worktreesByRepo)
        .flat()
        .find((w) => w.id === state.activeWorktreeId)
      if (wt) {
        const sep = wt.path.includes('\\') ? '\\' : '/'
        await window.api.fs.writeFile({
          filePath: `${wt.path}${sep}orca.yaml`,
          content: 'scripts:\n  setup: echo SETUP_COMPLETE\n'
        })
      }
    })
  })

  test.afterEach(async ({ orcaPage }) => {
    for (const id of createdWorktreeIds) {
      await removeWorktreeViaStore(orcaPage, id)
    }
    createdWorktreeIds.length = 0
  })

  /**
   * Force WebGL context loss on visible canvases immediately after a setup
   * split. In production, Chromium reclaims WebGL contexts under memory
   * pressure — especially with many worktrees open. The recovery path is:
   * onContextLoss → dispose WebGL → DOM fallback → rAF → fit + refresh.
   */
  test('@headful setup-split with forced WebGL context loss recovers', async ({ orcaPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const newId = await createAndActivateWorktreeWithSetup(orcaPage, `ctxloss-${i}`, 'vertical')
      createdWorktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await waitForPaneCount(orcaPage, 2, 15_000)

      const lostCount = await orcaPage.evaluate(() => {
        const canvases = document.querySelectorAll('.pane canvas:not(.xterm-link-layer)')
        let lost = 0
        for (const canvas of canvases) {
          const gl =
            (canvas as HTMLCanvasElement).getContext('webgl2') ??
            (canvas as HTMLCanvasElement).getContext('webgl')
          if (gl) {
            const ext = gl.getExtension('WEBGL_lose_context')
            if (ext) {
              ext.loseContext()
              lost++
            }
          }
        }
        return lost
      })
      if (lostCount > 0) {
        console.log(`[ctxloss-${i}] Forced context loss on ${lostCount} canvases`)
      }

      await orcaPage.waitForTimeout(500)
      await waitForAllPanesToHaveContent(orcaPage, `ctxloss-${i} after context loss`)

      await switchToWorktree(orcaPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(orcaPage, newId)
      createdWorktreeIds.pop()
    }
  })

  /**
   * Switch worktrees WITHOUT waiting for the split to settle. This hits the
   * race between wrapInSplit() reparenting, WebGL context creation during
   * resumeRendering(), and the scheduleSplitScrollRestore 200ms timer.
   */
  test('@headful rapid worktree switching during setup-split lifecycle', async ({ orcaPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    for (let i = 0; i < 3; i++) {
      const newId = await createAndActivateWorktreeWithSetup(orcaPage, `rapid-${i}`, 'vertical')
      createdWorktreeIds.push(newId)

      // Switch away during the ~200ms scheduleSplitScrollRestore window
      await orcaPage.waitForTimeout(50)
      await switchToWorktree(orcaPage, homeWorktreeId)
      await orcaPage.waitForTimeout(50)

      // Switch back — triggers resumeRendering on partially-initialized panes
      await switchToWorktree(orcaPage, newId)
      await expect.poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await waitForPaneCount(orcaPage, 2, 15_000)
      await waitForAllPanesToHaveContent(orcaPage, `rapid-${i} after return`)

      await switchToWorktree(orcaPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(orcaPage, newId)
      createdWorktreeIds.pop()
    }
  })
})
