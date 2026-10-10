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

test('converted editor has one file record per document', async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
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
      `printf '# ${marker}\n\nHost-owned Markdown.\n' > '${host.remoteRepoPath}/README.md'`
    )
    const seeded = seedRelayEraProfile(session.userDataDir, host.input, {
      repoPath: host.remoteRepoPath,
      folderPath: host.remoteFolderPath
    })
    const launched = await session.launch()
    app = launched.app
    const page = launched.page
    page.on('console', (message) => {
      if (message.text().startsWith('[editor-records]')) {
        console.log(message.text())
      }
    })
    await page.evaluate((worktreeId) => {
      const store = window.__store
      if (!store) {
        throw new Error('Missing renderer store')
      }
      const report = (state: ReturnType<typeof store.getState>) => {
        console.log(
          '[editor-records]',
          JSON.stringify({
            files: state.openFiles.filter((file) => file.worktreeId === worktreeId),
            tabs: state.unifiedTabsByWorktree[worktreeId],
            activeHost: state.activeWorkspaceExecutionHostId,
            trace: new Error('Editor file mutation').stack
          })
        )
      }
      report(store.getState())
      store.subscribe((state, previous) => {
        if (state.openFiles !== previous.openFiles) {
          report(state)
        }
      })
    }, seeded.worktreeId)
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
    console.log(
      '[host-tabs]',
      await serverCall(page, environment.id, 'session.tabs.list', {
        worktree: `id:${seeded.worktreeId}`
      })
    )
    const files = await page.evaluate(
      (worktreeId) =>
        window.__store?.getState().openFiles.filter((file) => file.worktreeId === worktreeId),
      seeded.worktreeId
    )
    console.log('[final-editor-files]', JSON.stringify(files))
    await page.screenshot({ path: testInfo.outputPath('editor-records.png') })
    expect(files?.filter((file) => file.filePath === seeded.sessionFilePath)).toHaveLength(1)
    const savedMarker = `SAVED_${marker}`
    const editor = page.locator('.rich-markdown-editor[contenteditable="true"]')
    await editor.click()
    await editor.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
    await editor.press('Enter')
    await page.keyboard.insertText(savedMarker)
    await editor.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expect
      .poll(() => host.exec!(`cat '${seeded.sessionFilePath}'`), { timeout: 30_000 })
      .toContain(savedMarker)
    console.log('[saved-on-host]', host.exec!(`cat '${seeded.sessionFilePath}'`))
    await session.close(app)
    app = null
    const restarted = await session.launch()
    app = restarted.app
    await waitForSessionReady(restarted.page)
    await waitForStartupWorktreeRefresh(restarted.page)
    await restarted.page.evaluate(
      ({ id, hostId }) => window.__store?.getState().setActiveWorktree(id, hostId),
      {
        id: seeded.worktreeId,
        hostId: toRuntimeExecutionHostId(environment.id)
      }
    )
    await dismissTransientAnnouncement(restarted.page)
    await expect(restarted.page.locator('.rich-markdown-editor')).toContainText(savedMarker, {
      timeout: 30_000
    })
    const restoredFiles = await restarted.page.evaluate(
      (worktreeId) =>
        window.__store?.getState().openFiles.filter((file) => file.worktreeId === worktreeId),
      seeded.worktreeId
    )
    console.log('[restored-editor-files]', JSON.stringify(restoredFiles))
    expect(restoredFiles?.filter((file) => file.filePath === seeded.sessionFilePath)).toHaveLength(
      1
    )
    await restarted.page.screenshot({ path: testInfo.outputPath('editor-restored.png') })
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
    host.cleanup()
  }
})
