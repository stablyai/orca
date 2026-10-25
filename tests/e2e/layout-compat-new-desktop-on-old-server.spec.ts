/**
 * Layout rework P3 baseline for the frozen path: the current desktop against a pinned released
 * headless server. The desktop splits a server pane, drags the divider, renames a pane and
 * reconnects after the server restarts. Each step records the old server's `session.tabs.list`
 * and the pane tree the desktop holds and draws; the rework's frozen adapter must match them.
 *
 * Needs ORCA_CROSS_VERSION_PACKAGED_EXECUTABLE (CI: packaged-browser-e2e.yml, job layout-compat).
 */
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import {
  launchPackagedServeHost,
  packagedExecutable,
  packagedExecutableMissing,
  PACKAGED_EXECUTABLE_ENV
} from './helpers/packaged-old-orca'
import {
  expectLayoutCompatBaseline,
  expectReconnectedPaneEcho,
  IdLabels,
  paneTreeBaseline,
  readSessionTabs,
  readSettled,
  readTerminals,
  sessionTabsBaseline
} from './helpers/layout-compat-baseline'
import { setPaneTitleFromTerminalMenu } from './helpers/terminal-pane-title-actions'
import { readTerminalAccessibilityText } from './helpers/terminal-accessibility-tree'
import type { TerminalLayoutSnapshot } from '../../src/shared/terminal-tab-types'

const PANE = '.pane[data-leaf-id]:visible'
// The default split-right binding, the same in the pinned release.
const SPLIT_RIGHT = process.platform === 'darwin' ? 'Meta+d' : 'Control+Shift+D'

/** The shown tab's pane tree and titles as the desktop holds them, and the panes it draws. */
async function readDesktop(page: Page, labels: IdLabels) {
  const held = await page.evaluate(() => {
    const state = window.__store?.getState()
    const tabId = state?.activeTabId ?? null
    const layout: TerminalLayoutSnapshot | null = tabId
      ? (state?.terminalLayoutsByTabId[tabId] ?? null)
      : null
    return {
      tabCount: document.querySelectorAll('[data-testid="sortable-tab"]').length,
      drawnPaneTitles: [...document.querySelectorAll<HTMLElement>('.pane-title-text')]
        .filter((title) => title.offsetParent !== null)
        .map((title) => title.textContent?.trim() ?? ''),
      root: layout?.root ?? null,
      titlesByLeafId: layout?.titlesByLeafId ?? {}
    }
  })
  const drawn = await page
    .locator(PANE)
    .evaluateAll((panes) => panes.map((pane) => pane.dataset.leafId ?? ''))
  return {
    // A count: a tab's label follows its focused pane's shell title, which differs per machine.
    tabs: held.tabCount,
    tree: paneTreeBaseline(held.root, labels),
    paneTitles: Object.entries(held.titlesByLeafId)
      .map(([leafId, title]) => `${labels.label('leaf', leafId)}=${title}`)
      .sort(),
    drawnPanes: drawn.map((leafId) => labels.label('leaf', leafId)),
    drawnPaneTitles: held.drawnPaneTitles
  }
}

/** A pointer drag of the first vertical divider, a quarter of the pane area to the right. */
async function dragDivider(page: Page): Promise<void> {
  const divider = page.locator('.pane-divider.is-vertical:visible').first()
  const box = (await divider.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 200, y, { steps: 20 })
  await page.mouse.up()
}

test.describe('layout compat: current desktop on a released server', () => {
  test.skip(packagedExecutableMissing, `${PACKAGED_EXECUTABLE_ENV} must point at a released Orca`)

  test('new-desktop-on-old-server: split, divider drag, pane rename, reconnect', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(300_000)
    const host = await launchPackagedServeHost(packagedExecutable!)
    try {
      await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
      await host.client.call('terminal.create', {
        worktree: `path:${testRepoPath}`,
        title: 'host-made'
      })
      const desktop = await launchPairedElectronClient(host.offer, testInfo, 'released server')
      try {
        const page = desktop.page
        let worktreeId = ''
        await expect
          .poll(
            async () =>
              (worktreeId = await page.evaluate(
                (repo) =>
                  window.__store
                    ?.getState()
                    .allWorktrees()
                    .find((worktree) => worktree.path === repo)?.id ?? '',
                testRepoPath
              )),
            { timeout: 60_000 }
          )
          .not.toBe('')
        const status = await page.evaluate(async (environmentId) => {
          const response = await window.api.runtimeEnvironments.getStatus({
            selector: environmentId,
            timeoutMs: 30_000
          })
          return response.ok ? response.result : null
        }, desktop.environmentId)

        const labels = new IdLabels()
        const steps: unknown[] = []
        const record = async (step: string): Promise<void> => {
          const observed = await readSettled(async () => ({
            oldServer: sessionTabsBaseline(
              await readSessionTabs(host.client, `path:${testRepoPath}`),
              labels
            ),
            oldServerTerminals: await readTerminals(host.client, `path:${testRepoPath}`, labels),
            desktop: await readDesktop(page, labels)
          }))
          steps.push({ step, ...observed })
        }

        await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
        await expect(page.locator(PANE)).toHaveCount(1, { timeout: 60_000 })
        await record('desktop shows the server workspace')

        const firstLeaf = await page
          .locator(PANE)
          .first()
          .evaluate((pane) => pane.dataset.leafId ?? '')
        await page.locator(`${PANE} .xterm`).first().click()
        await page.keyboard.press(SPLIT_RIGHT)
        await expect(page.locator(PANE)).toHaveCount(2, { timeout: 30_000 })
        await record('desktop splits right')

        await dragDivider(page)
        await record('desktop drags the divider')

        await setPaneTitleFromTerminalMenu(page, 'renamed-pane')
        await record('desktop renames a pane')

        await host.restart()
        await expectReconnectedPaneEcho({
          page,
          environmentId: desktop.environmentId,
          leafId: firstLeaf,
          host: host.client,
          worktree: `path:${testRepoPath}`,
          // The focused pane is the one typed into; its tab's manager reads that pane.
          readDrawn: async () =>
            readTerminalAccessibilityText(
              page,
              (await page.evaluate(() => window.__store?.getState().activeTabId)) ?? ''
            )
        })
        await record('after the server restarts and the desktop reconnects')

        await expectLayoutCompatBaseline(testInfo, 'new-desktop-on-old-server', {
          runtimeProtocolVersion: status?.runtimeProtocolVersion ?? null,
          steps
        })
      } finally {
        await desktop.dispose()
      }
    } finally {
      await host.dispose()
    }
  })
})
