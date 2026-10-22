import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { createPdfFindFixture } from './helpers/pdf-find-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const MB = 1024 * 1024
// Why: one paired reply carries 512 KiB of text (files.read) and about 3 MB of binary.
const PDF_SIZES_MB = [2, 5, 20]
const HTML_SIZES_MB = [2, 5, 20]

function largeHtml(bytes: number, marker: string): string {
  const row = '<tr><td>row</td><td>café</td></tr>\n'
  return `<html><body><table>\n${row.repeat(Math.floor(bytes / row.length))}</table><p>${marker}</p></body></html>\n`
}

async function openExplorerFile(page: Page, name: string): Promise<void> {
  const row = page.locator('[data-file-explorer-row]').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
}

test('opens HTML and PDF files larger than one RPC reply on a paired runtime', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.setTimeout(600_000)
  const fixtures: { name: string; sizeMb: number; kind: 'pdf' | 'html' }[] = [
    ...PDF_SIZES_MB.map((sizeMb) => ({
      name: `large-${sizeMb}mb.pdf`,
      sizeMb,
      kind: 'pdf' as const
    })),
    ...HTML_SIZES_MB.map((sizeMb) => ({
      name: `large-${sizeMb}mb.html`,
      sizeMb,
      kind: 'html' as const
    }))
  ]
  for (const fixture of fixtures) {
    const fixturePath = path.join(testRepoPath, fixture.name)
    writeFileSync(
      fixturePath,
      fixture.kind === 'pdf'
        ? createPdfFindFixture({ paddingBytes: fixture.sizeMb * MB })
        : largeHtml(fixture.sizeMb * MB, `end-marker-${fixture.sizeMb}`)
    )
    registerPostElectronShutdownCleanup(async () => rmSync(fixturePath, { force: true }))
  }
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(offer, testInfo, 'Remote large file open')
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

    // The host still refuses the one-reply reads, which is what makes these the oversized paths.
    const oneReply = await page.evaluate(
      async ({ environmentId, worktreeId }) => ({
        pdf: await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'files.readPreview',
          params: { worktree: `id:${worktreeId}`, relativePath: 'large-5mb.pdf' }
        }),
        html: await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'files.read',
          params: { worktree: `id:${worktreeId}`, relativePath: 'large-2mb.html' }
        })
      }),
      { environmentId, worktreeId }
    )
    expect(oneReply.pdf).toMatchObject({ ok: false, error: { message: 'file_too_large' } })
    expect(oneReply.html).toMatchObject({ ok: true, result: { truncated: true } })

    await openFileExplorer(page)
    for (const fixture of fixtures) {
      await openExplorerFile(page, fixture.name)
      if (fixture.kind === 'pdf') {
        await expect(page.locator('.pdfViewer .page')).toHaveCount(3, { timeout: 120_000 })
        await expect(page.locator('.pdfViewer .page').first().locator('.textLayer')).toContainText(
          'needle result 1',
          { timeout: 60_000 }
        )
      } else {
        // The tail marker is past every one-reply cap, so seeing it proves the whole file loaded.
        await expect
          .poll(() => page.evaluate(() => window.__monacoEditorE2E?.snapshot().valueTail ?? ''), {
            timeout: 120_000,
            message: `${fixture.name} never loaded in full`
          })
          .toContain(`end-marker-${fixture.sizeMb}`)
      }
      await expect(page.getByText('Unable to load file')).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath(`${fixture.name}.png`) })
    }
  } finally {
    await client?.page
      .screenshot({ path: testInfo.outputPath('paired-large-file-final.png') })
      .catch(() => undefined)
    await client?.dispose()
  }
})
