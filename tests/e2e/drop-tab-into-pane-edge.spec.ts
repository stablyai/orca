import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { dragTabIntoPane } from './helpers/terminal-layout-journeys'
import { SORTABLE_TAB } from './helpers/terminal-tab-menu'
import {
  expectJoinedAndRestored,
  openTargetAndSourceTabs,
  seededRepoPath
} from './helpers/terminal-tab-join-journey'

test('drops a running terminal tab on the right edge of another tab pane, surviving two relaunches @golden', async (// oxlint-disable-next-line no-empty-pattern -- this test owns every Electron launch.
{}, testInfo) => {
  test.setTimeout(420_000)
  const repoPath = seededRepoPath()
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null

  try {
    const first = await session.launch()
    app = first.app
    const page = first.page
    await page.setViewportSize({ width: 1200, height: 900 })
    const setup = await openTargetAndSourceTabs(page, repoPath)

    // The target is the tab on screen while the source is dragged from the strip.
    await page.locator(`${SORTABLE_TAB}[data-tab-id="${setup.targetTabId}"]`).click()
    await expect(page.locator(`.pane[data-leaf-id="${setup.targetLeafId}"]`)).toBeVisible()
    await dragTabIntoPane(page, {
      sourceTabId: setup.sourceTabId,
      targetTabId: setup.targetTabId,
      leafId: setup.targetLeafId,
      side: 'right'
    })

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
