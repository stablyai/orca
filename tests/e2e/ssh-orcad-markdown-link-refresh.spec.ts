import { expect, test } from './helpers/orca-app'
import { serverCall } from './helpers/orcad-convert-flow'
import {
  launchManagedWorkspace,
  skipUnlessManagedDockerHost,
  withManagedHost
} from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()

test('retained rich Markdown links refresh after remote document metadata arrives', async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
{}, testInfo) => {
  test.setTimeout(4 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    const { host } = fixture
    const marker = `REMOTE_MARKDOWN_${Date.now()}`
    host.exec!(
      `printf '# ${marker}\n\nHost-owned Markdown.\n\n[[NOTES]]\n' > '${host.remoteRepoPath}/README.md'`
    )
    host.exec!(`printf '# SIBLING_${marker}\n' > '${host.remoteRepoPath}/NOTES.md'`)
    const { page, seeded, environmentId } = await launchManagedWorkspace(fixture, {
      onLaunch: (page) => {
        page.on('console', (message) => {
          if (message.type() === 'error') {
            console.log('[renderer-error]', message.text())
          }
        })
      }
    })
    await expect(page.locator('.rich-markdown-editor')).toContainText(marker, { timeout: 30_000 })
    const documents = await serverCall(page, environmentId, 'files.listMarkdownDocuments', {
      worktree: `id:${seeded.worktreeId}`
    })
    console.log('[host-documents]', documents)
    expect(documents).toContain('NOTES.md')
    const link = page.locator('.rich-markdown-editor [data-doc-link-target="NOTES"]')
    await expect(link).toBeVisible()
    console.log('[rich-link-state]', await link.getAttribute('class'))
    await page.screenshot({ path: testInfo.outputPath('rich-link-state.png') })
    await expect(link).not.toHaveClass(/rich-markdown-doc-link--missing/, { timeout: 10_000 })
    await link.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
    await expect(
      page.getByRole('heading', { name: `SIBLING_${marker}`, exact: true })
    ).toBeVisible()
    const opened = await page.evaluate(
      (filePath) => window.__store?.getState().openFiles.find((file) => file.filePath === filePath),
      `${host.remoteRepoPath}/NOTES.md`
    )
    console.log('[rich-link-opened-file]', JSON.stringify(opened))
    expect(opened?.runtimeEnvironmentId).toBe(environmentId)
    await page.screenshot({ path: testInfo.outputPath('markdown-converted-ready.png') })
  })
})
