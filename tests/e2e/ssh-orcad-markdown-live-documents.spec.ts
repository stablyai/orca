import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { convertAndRetain, serverCall } from './helpers/orcad-convert-flow'
import { waitForSessionReady, waitForStartupWorktreeRefresh } from './helpers/store'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(!TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Needs Docker and server template')

test('open remote Markdown previews discover host-created documents', async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
{}, testInfo) => {
  test.setTimeout(4 * 60_000)
  const host = startOrcadConvertHost('docker', testInfo)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE! })
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await session.close(app)
    app = null
    const marker = `REMOTE_MARKDOWN_${Date.now()}`
    host.exec!(
      `printf '# ${marker}\n\nHost-owned Markdown.\n\n[[LATE]]\n' > '${host.remoteRepoPath}/README.md'`
    )
    const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
      repoPath: host.remoteRepoPath,
      folderPath: host.remoteFolderPath
    })
    const launched = await session.launch()
    app = launched.app
    let page = launched.page
    page.on('console', (message) => {
      if (
        message.type() === 'error' ||
        message.type() === 'warning' ||
        message.text().startsWith('[file-change-event]')
      ) {
        console.log('[renderer-error]', message.text())
      }
    })
    await waitForSessionReady(page)
    await convertAndRetain(page, session.userDataDir, seeded)
    const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
      (e) => e.orcadDeployment?.sshTargetId === seeded.targetId
    )
    if (!environment) {
      throw new Error('Missing managed environment')
    }
    await session.close(app)
    app = null
    const restarted = await session.launch()
    app = restarted.app
    page = restarted.page
    page.on('console', (message) => {
      if (
        message.type() === 'error' ||
        message.type() === 'warning' ||
        message.text().startsWith('[file-change-event]')
      ) {
        console.log('[renderer-event]', message.text())
      }
    })
    await waitForSessionReady(page)
    await waitForStartupWorktreeRefresh(page)
    await page.evaluate(
      ({ id, hostId }) => window.__store?.getState().setActiveWorktree(id, hostId),
      {
        id: seeded.worktreeId,
        hostId: toRuntimeExecutionHostId(environment.id)
      }
    )
    await dismissTransientAnnouncement(page)
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
        environmentId: environment.id
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
    const documents = await serverCall(page, environment.id, 'files.listMarkdownDocuments', {
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
    const removed = await serverCall(page, environment.id, 'files.listMarkdownDocuments', {
      worktree: `id:${seeded.worktreeId}`
    })
    console.log('[host-removed-documents]', removed)
    expect(removed).not.toContain('LATE.md')
    await expect(page.getByText('LATE.md', { exact: true })).not.toBeVisible({ timeout: 30_000 })
    await expect(link).toHaveClass(/markdown-doc-link-broken/, { timeout: 10_000 })
    await page.screenshot({ path: testInfo.outputPath('live-document-removed.png') })
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    host.cleanup()
  }
})
