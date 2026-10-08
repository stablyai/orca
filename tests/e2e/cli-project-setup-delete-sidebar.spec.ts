import path from 'node:path'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { ProjectHostSetup } from '../../src/shared/project-types'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('drops a project from the open window when the CLI removes its host setup', async ({
  orcaPage,
  electronApp,
  testRepoPath
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  // Why: the list's accessible name is translated, so the header is found by its data attribute.
  const projectHeader = orcaPage.locator('[data-repo-header-id]', {
    hasText: path.basename(testRepoPath)
  })
  await expect(projectHeader).toBeVisible()

  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  // Why: the local runtime socket is the transport `orca project setup-delete` uses.
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  const listed = await client.call<{ setups: ProjectHostSetup[] }>('projectHostSetup.list')
  const setup = listed.result.setups.find((entry) => entry.path === testRepoPath)
  if (!setup) {
    throw new Error(`No host setup for the seeded repo: ${testRepoPath}`)
  }

  try {
    await client.call('projectHostSetup.delete', { setupId: setup.id })
    await expect(projectHeader, 'the window still lists the removed project').toHaveCount(0, {
      timeout: 15_000
    })
  } finally {
    await orcaPage.screenshot({ path: testInfo.outputPath('after-cli-removal.png') })
  }
})
