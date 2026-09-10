import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { publishAuthenticatedHarness } from './fixtures/maestro-workspace-tab-canvas/coordinator-bridge'
import { openMaestro } from './fixtures/maestro-workspace-tab-canvas/evidence'

test.describe('Maestro Run completion in Electron', () => {
  test('shows authenticated explicit completion independently of live resources', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    let cleanupHarness = async (): Promise<void> => {}
    try {
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const scope = await openMaestro(orcaPage, true)
      const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      const harness = await publishAuthenticatedHarness({
        page: orcaPage,
        userDataDir,
        scope,
        browserPageId: 'mwc-completion-smoke-page',
        browserUrl: 'http://127.0.0.1:1/mwc-completion-smoke'
      })
      cleanupHarness = harness.cleanup

      await harness.complete()
      await openMaestro(orcaPage, true)
      const progress = orcaPage.getByRole('complementary', { name: 'Run progress' })
      await expect(progress).toContainText('Verified Maestro Canvas handoff is complete.')
      await expect(progress).toContainText('Focused orchestration and Canvas checks passed.')
      await expect(progress).toContainText(
        'The live coordinator resource remains available for visual inspection.'
      )
    } finally {
      await cleanupHarness()
    }
  })
})
