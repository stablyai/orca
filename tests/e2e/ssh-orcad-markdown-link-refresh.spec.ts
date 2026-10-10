import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { startOrcadConvertHost } from './helpers/orcad-convert-host'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { convertAndRetain, serverCall } from './helpers/orcad-convert-flow'
import { waitForSessionReady } from './helpers/store'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'

const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(!TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Needs Docker and server template')

test('retained rich Markdown links refresh after remote document metadata arrives', async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
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
      `printf '# ${marker}\n\nHost-owned Markdown.\n\n[[NOTES]]\n' > '${host.remoteRepoPath}/README.md'`
    )
    host.exec!(`printf '# SIBLING_${marker}\n' > '${host.remoteRepoPath}/NOTES.md'`)
    const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
      repoPath: host.remoteRepoPath,
      folderPath: host.remoteFolderPath
    })
    const launched = await session.launch()
    app = launched.app
    const page = launched.page
    page.on('console', (message) => {
      if (message.type() === 'error') {
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
    await page.evaluate(
      ({ id, hostId }) => window.__store?.getState().setActiveWorktree(id, hostId),
      {
        id: seeded.worktreeId,
        hostId: toRuntimeExecutionHostId(environment.id)
      }
    )
    await dismissTransientAnnouncement(page)
    await expect(page.locator('.rich-markdown-editor')).toContainText(marker, { timeout: 30_000 })
    const documents = await serverCall(page, environment.id, 'files.listMarkdownDocuments', {
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
    expect(opened?.runtimeEnvironmentId).toBe(environment.id)
    await page.screenshot({ path: testInfo.outputPath('markdown-converted-ready.png') })
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    host.cleanup()
  }
})
