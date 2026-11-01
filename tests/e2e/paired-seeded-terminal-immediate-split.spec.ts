import type { RuntimeTerminalListResult } from '../../src/shared/runtime-types'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { waitForBoundPanes } from './helpers/terminal-layout-journeys'
import { splitActiveTerminalPane } from './helpers/terminal'

const PANE = '.pane[data-leaf-id]:visible'

// A split issued while the desktop's seeded first tab is still settling must still give the new
// pane a live server terminal, not a blank pane.
test('a split right after the first terminal of an empty paired-server workspace binds both panes', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  const host = await launchHeadlessPairedRuntimeHost()
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const desktop = await launchPairedElectronClient(host.offer, testInfo, 'seeded split')
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
      await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
      // Split the moment the seeded pane mounts, before its terminal has attached.
      await expect(page.locator(PANE)).toHaveCount(1, { timeout: 60_000 })
      await splitActiveTerminalPane(page, 'vertical')
      await waitForBoundPanes(page, 2)

      const leafIds = await page
        .locator(PANE)
        .evaluateAll((panes) => panes.map((pane) => pane.getAttribute('data-leaf-id') ?? ''))
      await expect
        .poll(
          async () => {
            const { terminals } = (
              await host.client.call<RuntimeTerminalListResult>('terminal.list', {
                worktree: `id:${worktreeId}`
              })
            ).result
            return leafIds.every((leafId) =>
              terminals.some((terminal) => terminal.leafId === leafId)
            )
          },
          { timeout: 30_000, message: 'a split pane has no server terminal' }
        )
        .toBe(true)
    } finally {
      await desktop.dispose()
    }
  } finally {
    await host.dispose()
  }
})
