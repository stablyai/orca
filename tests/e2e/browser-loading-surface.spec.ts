import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { crashGuestRenderer } from './browser-guest-runtime-oracle'
import { observeBrowserLoadingSurface } from './browser-loading-surface-oracle'

test('browser host follows the theme before content and preserves the webpage canvas', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const observations = await observeBrowserLoadingSurface(
    orcaPage,
    (name) => testInfo.outputPath(name),
    async (id) => {
      await crashGuestRenderer(electronApp, id)
    }
  )
  expect(observations.filter((entry) => !entry.pass)).toEqual([])
})
