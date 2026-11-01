// Require @headful WebGL: DOM fallback cannot reproduce canvas staleness after split reparenting.

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
  waitForAllPanesToHaveContent,
  checkWebglState
} from './helpers/dead-terminal'

const STRESS_ITERATIONS = 5

test.describe('Dead Terminal Reproduction @headful', () => {
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

  test('@headful manual-split flow does not produce dead terminals', async ({ orcaPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await checkWebglState(orcaPage, 'home-initial')

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const direction = i % 2 === 0 ? 'vertical' : 'horizontal'
      const newId = await createAndActivateWorktreeWithManualSplit(
        orcaPage,
        `setup-${i}`,
        direction
      )
      createdWorktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await waitForPaneCount(orcaPage, 2, 15_000)
      await checkWebglState(orcaPage, `setup-${i}`)
      await waitForAllPanesToHaveContent(orcaPage, `setup-${i} both panes`)

      await switchToWorktree(orcaPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(orcaPage, newId)
      createdWorktreeIds.pop()
    }
  })

  test('@headful manual-split then switch-back does not leave panes dead', async ({ orcaPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const newId = await createAndActivateWorktreeWithManualSplit(
        orcaPage,
        `switchback-${i}`,
        'vertical'
      )
      createdWorktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await waitForPaneCount(orcaPage, 2, 15_000)
      await waitForAllPanesToHaveContent(orcaPage, `switchback-${i} initial`)

      await switchToWorktree(orcaPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 15_000)

      await switchToWorktree(orcaPage, newId)
      await expect.poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 15_000)
      await waitForAllPanesToHaveContent(orcaPage, `switchback-${i} after return`)

      await switchToWorktree(orcaPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(orcaPage, newId)
      createdWorktreeIds.pop()
    }
  })

  test('@headful rapid switching between many manual-split worktrees', async ({ orcaPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const worktreeIds = [homeWorktreeId]
    for (let i = 0; i < 4; i++) {
      const newId = await createAndActivateWorktreeWithManualSplit(
        orcaPage,
        `multi-${i}`,
        'vertical'
      )
      createdWorktreeIds.push(newId)
      worktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await waitForPaneCount(orcaPage, 2, 15_000)
      await waitForAllPanesToHaveContent(orcaPage, `multi-create-${i}`)
    }

    for (let round = 0; round < 3; round++) {
      for (const wId of worktreeIds) {
        await switchToWorktree(orcaPage, wId)
        await expect.poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 }).toBe(wId)
        await ensureTerminalVisible(orcaPage)
        await waitForActiveTerminalManager(orcaPage, 15_000)
        await waitForAllPanesToHaveContent(orcaPage, `multi-r${round}-${wId.slice(0, 8)}`)
      }
    }
  })
})
