/**
 * Office document preview, end to end.
 *
 * The two properties worth an Electron launch are the ones no unit test can reach: that a real
 * `.docx` rendered by the host's `officecli` paints inside the locked-down preview partition with
 * no CSP violation, and that a format Orca does not render says so itself instead of blaming the
 * toolchain.
 *
 * Skipped where `officecli` is absent — the render half genuinely needs it, and a mocked host
 * would only prove our own plumbing calls itself.
 */
import { copyFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { hasOfficecliInstalled } from './helpers/officecli-availability'

const FIXTURES = path.join(process.cwd(), 'src', 'main', 'office', '__fixtures__')

test.describe('office document preview', () => {
  test('renders a .docx inside the preview partition', async ({ orcaPage: page }, testInfo) => {
    test.skip(!(await hasOfficecliInstalled()), 'officecli is not installed on this machine')
    await waitForSessionReady(page)
    const worktreeId = await waitForActiveWorktree(page)
    const worktreePath = await page.evaluate(
      (id) => window.__store?.getState().getKnownWorktreeById(id)?.path ?? null,
      worktreeId
    )
    expect(worktreePath).not.toBeNull()
    // Not `document`: shadowing the DOM global inside a page.evaluate is how a stray query
    // silently reads a string instead of the page.
    const documentPath = path.join(worktreePath as string, 'report.docx')
    copyFileSync(path.join(FIXTURES, 'sample.docx'), documentPath)

    await page.evaluate(
      ([id, filePath]) => {
        const state = window.__store?.getState()
        state?.createBrowserTab(id, 'data:text/html,', {
          docLocation: { kind: 'workspace-doc', worktreeId: id, filePath },
          title: 'report.docx',
          browserRuntimeEnvironmentId: null,
          activate: true
        })
      },
      [worktreeId, documentPath] as const
    )
    await page.evaluate(() => window.__store?.getState().setActiveTabType('browser'))

    // The rendered document paints in the fenced partition, under the same strict CSP an HTML
    // workspace document gets. A blank guest here means the self-contained-HTML property broke.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const guest = document.querySelector('webview[src^="orca-preview://"]') as {
              executeJavaScript?: (code: string) => Promise<unknown>
            } | null
            if (!guest?.executeJavaScript) {
              return null
            }
            try {
              return (await guest.executeJavaScript('document.body?.innerText ?? null')) as
                | string
                | null
            } catch {
              return null
            }
          }),
        { timeout: 120_000, message: 'the Office snapshot never painted' }
      )
      .toContain('Orca Office preview fixture')

    await page.screenshot({
      path: testInfo.outputPath('office-docx-preview.png'),
      animations: 'disabled'
    })
  })

  test('names an unrenderable format without mentioning officecli', async ({ orcaPage: page }) => {
    await waitForSessionReady(page)
    const worktreeId = await waitForActiveWorktree(page)
    const worktreePath = await page.evaluate(
      (id) => window.__store?.getState().getKnownWorktreeById(id)?.path ?? null,
      worktreeId
    )
    const legacy = path.join(worktreePath as string, 'legacy.doc')
    writeFileSync(legacy, 'not really a Word 97 file')

    await page.evaluate(
      ([id, filePath]) => {
        const state = window.__store?.getState()
        state?.createBrowserTab(id, 'data:text/html,', {
          docLocation: { kind: 'workspace-doc', worktreeId: id, filePath },
          title: 'legacy.doc',
          browserRuntimeEnvironmentId: null,
          activate: true
        })
      },
      [worktreeId, legacy] as const
    )
    await page.evaluate(() => window.__store?.getState().setActiveTabType('browser'))

    const panel = page.getByText('Orca does not preview Word 97–2003 files.')
    await expect(panel).toBeVisible({ timeout: 30_000 })
    // The tool was not the problem, so offering an install would send the reader to fix something
    // that is already fine.
    await expect(page.getByText(/officecli/i)).toHaveCount(0)
  })
})
