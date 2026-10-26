// Require @headful WebGL for context-loss and split-restore race coverage.

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
  createAndActivateWorktreeWithManualSplit,
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
  })

  test.afterEach(async ({ orcaPage }) => {
    for (const id of createdWorktreeIds) {
      await removeWorktreeViaStore(orcaPage, id)
    }
    createdWorktreeIds.length = 0
  })

  // Force context loss like Chromium under memory pressure; recovery must fall back to DOM then fit/refresh.
  test('@headful manual-split with forced WebGL context loss recovers', async ({ orcaPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const newId = await createAndActivateWorktreeWithManualSplit(
        orcaPage,
        `ctxloss-${i}`,
        'vertical'
      )
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

  // Switch before split settlement to race reparenting, WebGL resume and the 200ms scroll-restore timer.
  test('@headful rapid worktree switching during manual-split lifecycle', async ({ orcaPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    for (let i = 0; i < 3; i++) {
      const newId = await createAndActivateWorktreeWithManualSplit(
        orcaPage,
        `rapid-${i}`,
        'vertical'
      )
      createdWorktreeIds.push(newId)

      // Switch away during the ~200ms scheduleSplitScrollRestore window
      await orcaPage.waitForTimeout(50)
      await switchToWorktree(orcaPage, homeWorktreeId)
      await orcaPage.waitForTimeout(50)

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
