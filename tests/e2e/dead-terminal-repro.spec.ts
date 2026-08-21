/**
 * Stress test for dead-terminal reproduction (setup-split flow).
 *
 * Why @headful: the dead-terminal bug is a WebGL canvas staleness issue — after
 * wrapInSplit() reparents the existing pane's container, the WebGL canvas can
 * fail to repaint. In headless mode WebGL is NEVER active, so the DOM fallback
 * renderer is used and the bug cannot manifest. Running headful ensures real
 * WebGL contexts matching production.
 *
 * See helpers/dead-terminal.ts for the shared worktree-creation helper that
 * replicates the exact activateAndRevealWorktree + ensureWorktreeHasInitialTerminal
 * production flow.
 */

import { test, expect } from './helpers/mcode-app'
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
  waitForAllPanesToHaveContent,
  checkWebglState
} from './helpers/dead-terminal'

const STRESS_ITERATIONS = 5

test.describe('Dead Terminal Reproduction @headful', () => {
  const createdWorktreeIds: string[] = []

  test.beforeEach(async ({ mcodePage }) => {
    await waitForSessionReady(mcodePage)
    await waitForActiveWorktree(mcodePage)
    await ensureTerminalVisible(mcodePage)

    await mcodePage.evaluate(async () => {
      const state = window.__store?.getState()
      if (!state) {
        return
      }
      state.updateSettings({ setupScriptLaunchMode: 'split-vertical' })
    })
  })

  test.afterEach(async ({ mcodePage }) => {
    for (const id of createdWorktreeIds) {
      await removeWorktreeViaStore(mcodePage, id)
    }
    createdWorktreeIds.length = 0
  })

  test('@headful setup-split flow does not produce dead terminals', async ({ mcodePage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(mcodePage)
    await waitForActiveTerminalManager(mcodePage, 30_000)
    await checkWebglState(mcodePage, 'home-initial')

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const direction = i % 2 === 0 ? 'vertical' : 'horizontal'
      const newId = await createAndActivateWorktreeWithSetup(mcodePage, `setup-${i}`, direction)
      createdWorktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(mcodePage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(mcodePage)
      await waitForActiveTerminalManager(mcodePage, 30_000)
      await waitForPaneCount(mcodePage, 2, 15_000)
      await checkWebglState(mcodePage, `setup-${i}`)
      await waitForAllPanesToHaveContent(mcodePage, `setup-${i} both panes`)

      await switchToWorktree(mcodePage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(mcodePage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(mcodePage, newId)
      createdWorktreeIds.pop()
    }
  })

  test('@headful setup-split then switch-back does not leave panes dead', async ({ mcodePage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(mcodePage)
    await waitForActiveTerminalManager(mcodePage, 30_000)

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const newId = await createAndActivateWorktreeWithSetup(
        mcodePage,
        `switchback-${i}`,
        'vertical'
      )
      createdWorktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(mcodePage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(mcodePage)
      await waitForActiveTerminalManager(mcodePage, 30_000)
      await waitForPaneCount(mcodePage, 2, 15_000)
      await waitForAllPanesToHaveContent(mcodePage, `switchback-${i} initial`)

      await switchToWorktree(mcodePage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(mcodePage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await ensureTerminalVisible(mcodePage)
      await waitForActiveTerminalManager(mcodePage, 15_000)

      await switchToWorktree(mcodePage, newId)
      await expect.poll(async () => getActiveWorktreeId(mcodePage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(mcodePage)
      await waitForActiveTerminalManager(mcodePage, 15_000)
      await waitForAllPanesToHaveContent(mcodePage, `switchback-${i} after return`)

      await switchToWorktree(mcodePage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(mcodePage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(mcodePage, newId)
      createdWorktreeIds.pop()
    }
  })

  test('@headful rapid switching between many setup-split worktrees', async ({ mcodePage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(mcodePage)
    await waitForActiveTerminalManager(mcodePage, 30_000)

    const worktreeIds = [homeWorktreeId]
    for (let i = 0; i < 4; i++) {
      const newId = await createAndActivateWorktreeWithSetup(mcodePage, `multi-${i}`, 'vertical')
      createdWorktreeIds.push(newId)
      worktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(mcodePage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(mcodePage)
      await waitForActiveTerminalManager(mcodePage, 30_000)
      await waitForPaneCount(mcodePage, 2, 15_000)
      await waitForAllPanesToHaveContent(mcodePage, `multi-create-${i}`)
    }

    for (let round = 0; round < 3; round++) {
      for (const wId of worktreeIds) {
        await switchToWorktree(mcodePage, wId)
        await expect.poll(async () => getActiveWorktreeId(mcodePage), { timeout: 10_000 }).toBe(wId)
        await ensureTerminalVisible(mcodePage)
        await waitForActiveTerminalManager(mcodePage, 15_000)
        await waitForAllPanesToHaveContent(mcodePage, `multi-r${round}-${wId.slice(0, 8)}`)
      }
    }
  })
})
