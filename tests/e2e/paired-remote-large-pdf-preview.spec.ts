import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { createPdfFindFixture } from './helpers/pdf-find-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const FIXTURE_NAME = 'paired-large-preview.pdf'
// Why: a paired host returns a preview in one RPC reply, which holds about 3 MB of binary.
const PADDING_BYTES = 4 * 1024 * 1024

test('opens a PDF larger than one RPC reply on a paired runtime', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.setTimeout(300_000)
  const fixturePath = path.join(testRepoPath, FIXTURE_NAME)
  writeFileSync(fixturePath, createPdfFindFixture({ paddingBytes: PADDING_BYTES }))
  registerPostElectronShutdownCleanup(async () => rmSync(fixturePath, { force: true }))
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(offer, testInfo, 'Remote large PDF preview')
    const { page, environmentId } = client
    const findWorktreeId = (): Promise<string | null> =>
      page.evaluate(
        (repoPath) =>
          window.__store
            ?.getState()
            .allWorktrees()
            .find((worktree) => worktree.path === repoPath)?.id ?? null,
        testRepoPath
      )
    await expect
      .poll(findWorktreeId, {
        timeout: 120_000,
        message: 'paired client never received the host worktree'
      })
      .not.toBeNull()
    const worktreeId = await findWorktreeId()
    await page.evaluate(
      ({ environmentId, worktreeId }) => {
        if (worktreeId) {
          window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
        }
      },
      { environmentId, worktreeId }
    )

    // The host refuses the single-reply read, which is what makes this the oversized path.
    const preview = await page.evaluate(
      async ({ environmentId, worktreeId, relativePath }) =>
        window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'files.readPreview',
          params: { worktree: `id:${worktreeId}`, relativePath }
        }),
      { environmentId, worktreeId, relativePath: FIXTURE_NAME }
    )
    expect(preview).toMatchObject({ ok: false, error: { message: 'file_too_large' } })

    await openFileExplorer(page)
    const fixtureRow = page.locator('[data-file-explorer-row]').filter({ hasText: FIXTURE_NAME })
    await expect(fixtureRow).toBeVisible({ timeout: 30_000 })
    await fixtureRow.click()

    await expect(page.locator('.pdfViewer .page')).toHaveCount(3, { timeout: 60_000 })
    await expect(page.locator('.pdfViewer .page').first().locator('.textLayer')).toContainText(
      'needle result 1'
    )
  } finally {
    // Why: taken on failure too, where the tab's error is the evidence, and the page is gone after dispose.
    await client?.page
      .screenshot({ path: testInfo.outputPath('paired-large-pdf.png') })
      .catch(() => undefined)
    await client?.dispose()
  }
})
