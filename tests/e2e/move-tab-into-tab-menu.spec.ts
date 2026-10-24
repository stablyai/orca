import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { SORTABLE_TAB } from './helpers/terminal-tab-menu'
import {
  expectJoinedAndRestored,
  openTargetAndSourceTabs,
  seededRepoPath,
  tabTitle
} from './helpers/terminal-tab-join-journey'

test('moves a running terminal into another tab from the tab menu, surviving two relaunches @golden', async (// oxlint-disable-next-line no-empty-pattern -- this test owns every Electron launch.
{}, testInfo) => {
  test.setTimeout(420_000)
  const repoPath = seededRepoPath()
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null

  try {
    const first = await session.launch()
    app = first.app
    const page = first.page
    const setup = await openTargetAndSourceTabs(page, repoPath)

    const targetTitle = await tabTitle(page, setup.targetTabId)
    const sourceTab = page.locator(`${SORTABLE_TAB}[data-tab-id="${setup.sourceTabId}"]`)
    const splitRight = page.getByRole('menuitem', { name: 'Split Right', exact: true })
    // The menu can be dismissed while it is still opening, so the whole walk to the last entry retries.
    await expect(async () => {
      await sourceTab.click({ button: 'right' })
      await page
        .getByRole('menuitem', { name: 'Move Into Tab', exact: true })
        .click({ timeout: 4_000 })
      await page.getByRole('menuitem', { name: targetTitle, exact: true }).click({ timeout: 4_000 })
      await expect(splitRight).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
    await splitRight.click()

    await expectJoinedAndRestored({
      session,
      page,
      app,
      setup,
      trackApp: (next) => {
        app = next
      }
    })
  } finally {
    if (app) {
      await session.close(app).catch(() => undefined)
    }
    await session.dispose()
  }
})
