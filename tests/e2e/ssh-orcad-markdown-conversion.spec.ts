import { expect, test } from './helpers/orca-app'
import { serverCall } from './helpers/orcad-convert-flow'
import {
  launchManagedWorkspace,
  skipUnlessManagedDockerHost,
  withManagedHost
} from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()

test('retained Markdown lists documents on its managed owner after conversion', async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
{}, testInfo) => {
  test.setTimeout(4 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    const { host } = fixture
    const marker = `REMOTE_MARKDOWN_${Date.now()}`
    host.exec!(
      `printf '# ${marker}\n\nHost-owned Markdown.\n\n[[NOTES]]\n' > '${host.remoteRepoPath}/README.md'`
    )
    host.exec!(`printf '# SIBLING_${marker}\n' > '${host.remoteRepoPath}/NOTES.md'`)
    const errors: string[] = []
    let failureScreenshot: Promise<void> | undefined
    const { page, seeded, environmentId } = await launchManagedWorkspace(fixture, {
      onLaunch: (page) => {
        page.on('console', (message) => {
          if (message.type() === 'error') {
            errors.push(message.text())
            console.log('[renderer-error]', message.text())
            if (
              message.text().includes('Failed to list markdown documents') &&
              !failureScreenshot
            ) {
              failureScreenshot = (async () => {
                await page.screenshot({ path: testInfo.outputPath('markdown-list-failure.png') })
              })()
            }
          }
        })
      }
    })
    await expect(page.locator('.rich-markdown-editor')).toContainText(marker, { timeout: 30_000 })
    console.log(
      '[markdown-conversion]',
      JSON.stringify({
        errors,
        files: await page.evaluate(() => window.__store?.getState().openFiles)
      })
    )
    await page.screenshot({ path: testInfo.outputPath('markdown-converted.png') })
    await failureScreenshot
    expect(errors.filter((e) => e.includes('Failed to list markdown documents'))).toEqual([])
    expect(
      await serverCall(page, environmentId, 'files.listMarkdownDocuments', {
        worktree: `id:${seeded.worktreeId}`
      })
    ).toContain('NOTES.md')
    const link = page.locator('.rich-markdown-editor [data-doc-link-target="NOTES"]')
    await expect(link).toBeVisible()
    console.log('[rich-link-state]', await link.getAttribute('class'))
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
    const previewLink = page
      .locator('.markdown-preview')
      .getByRole('link', { name: 'NOTES', exact: true })
    await expect(previewLink).toBeVisible()
    await expect(previewLink).not.toHaveClass(/markdown-doc-link-broken/)
    await previewLink.click()
    await expect(
      page.getByRole('heading', { name: `SIBLING_${marker}`, exact: true })
    ).toBeVisible()
    expect(errors.filter((e) => e.includes('Failed to list markdown documents'))).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('markdown-converted-ready.png') })
  })
})
