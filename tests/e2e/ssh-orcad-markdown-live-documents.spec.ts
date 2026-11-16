import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { serverCall } from './helpers/orcad-convert-flow'
import {
  activateManagedWorkspace,
  launchConvertedProfile,
  relaunchManagedApp,
  skipUnlessManagedDockerHost,
  withManagedHost
} from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()

function captureRendererMessages(page: Page, label: string): void {
  page.on('console', (message) => {
    if (
      message.type() === 'error' ||
      message.type() === 'warning' ||
      message.text().startsWith('[file-change-event]')
    ) {
      console.log(label, message.text())
    }
  })
}

test('open remote Markdown previews discover host-created documents', async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
{}, testInfo) => {
  test.setTimeout(4 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    const { host } = fixture
    const marker = `REMOTE_MARKDOWN_${Date.now()}`
    host.exec!(
      `printf '# ${marker}\n\nHost-owned Markdown.\n\n[[LATE]]\n' > '${host.remoteRepoPath}/README.md'`
    )
    const { seeded, environmentId } = await launchConvertedProfile(fixture, {
      onLaunch: (page) => captureRendererMessages(page, '[renderer-error]')
    })
    const page = await relaunchManagedApp(fixture, (page) =>
      captureRendererMessages(page, '[renderer-event]')
    )
    await activateManagedWorkspace(page, seeded.worktreeId, environmentId)
    await expect(page.locator('.rich-markdown-editor')).toContainText(marker, { timeout: 30_000 })
    await page.evaluate(
      ({ filePath, worktreeId, environmentId }) => {
        window.__store?.getState().openMarkdownPreview({
          filePath,
          relativePath: 'README.md',
          worktreeId,
          language: 'markdown',
          runtimeEnvironmentId: environmentId
        })
      },
      {
        filePath: seeded.sessionFilePath,
        worktreeId: seeded.worktreeId,
        environmentId
      }
    )
    const link = page.locator('.markdown-preview').getByRole('link', { name: 'LATE', exact: true })
    await expect(link).toBeVisible()
    await expect(link).toHaveClass(/markdown-doc-link-broken/)
    await page.evaluate(() => {
      window.addEventListener('orca:worktree-file-change', (event) => {
        if (event instanceof CustomEvent) {
          console.log('[file-change-event]', JSON.stringify(event.detail))
        }
      })
    })
    host.exec!(`printf '# LATE_${marker}\n' > '${host.remoteRepoPath}/LATE.md'`)
    const documents = await serverCall(page, environmentId, 'files.listMarkdownDocuments', {
      worktree: `id:${seeded.worktreeId}`
    })
    console.log('[host-created-documents]', documents)
    expect(documents).toContain('LATE.md')
    await expect(page.getByText('LATE.md', { exact: true })).toBeVisible({ timeout: 30_000 })
    console.log('[open-preview-link]', await link.getAttribute('class'))
    await page.screenshot({ path: testInfo.outputPath('live-document-observed.png') })
    await expect(link).not.toHaveClass(/markdown-doc-link-broken/, { timeout: 10_000 })
    console.log('[resolved-preview-link]', await link.getAttribute('class'))
    await page.screenshot({ path: testInfo.outputPath('live-document-created.png') })
    host.exec!(`rm '${host.remoteRepoPath}/LATE.md'`)
    const removed = await serverCall(page, environmentId, 'files.listMarkdownDocuments', {
      worktree: `id:${seeded.worktreeId}`
    })
    console.log('[host-removed-documents]', removed)
    expect(removed).not.toContain('LATE.md')
    await expect(page.getByText('LATE.md', { exact: true })).not.toBeVisible({ timeout: 30_000 })
    await expect(link).toHaveClass(/markdown-doc-link-broken/, { timeout: 10_000 })
    await page.screenshot({ path: testInfo.outputPath('live-document-removed.png') })
  })
})
