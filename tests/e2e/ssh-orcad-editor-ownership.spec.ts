import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { serverCall } from './helpers/orcad-convert-flow'
import {
  activateManagedWorkspace,
  launchManagedWorkspace,
  relaunchManagedApp,
  skipUnlessManagedDockerHost,
  withManagedHost
} from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()

async function reportEditorRecords(page: Page, worktreeId: string): Promise<void> {
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
  }, worktreeId)
}

test('converted editor has one file record per document', async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
{}, testInfo) => {
  test.setTimeout(4 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    const { host } = fixture
    const marker = `REMOTE_MARKDOWN_${Date.now()}`
    host.exec!(
      `printf '# ${marker}\n\nHost-owned Markdown.\n' > '${host.remoteRepoPath}/README.md'`
    )
    const { page, seeded, environmentId } = await launchManagedWorkspace(fixture, {
      onLaunch: (page, seeded) => reportEditorRecords(page, seeded.worktreeId)
    })
    await expect(page.locator('.rich-markdown-editor')).toContainText(marker, { timeout: 30_000 })
    console.log(
      '[host-tabs]',
      await serverCall(page, environmentId, 'session.tabs.list', {
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
    const restarted = await relaunchManagedApp(fixture)
    await activateManagedWorkspace(restarted, seeded.worktreeId, environmentId)
    await expect(restarted.locator('.rich-markdown-editor')).toContainText(savedMarker, {
      timeout: 30_000
    })
    const restoredFiles = await restarted.evaluate(
      (worktreeId) =>
        window.__store?.getState().openFiles.filter((file) => file.worktreeId === worktreeId),
      seeded.worktreeId
    )
    console.log('[restored-editor-files]', JSON.stringify(restoredFiles))
    expect(restoredFiles?.filter((file) => file.filePath === seeded.sessionFilePath)).toHaveLength(
      1
    )
    await restarted.screenshot({ path: testInfo.outputPath('editor-restored.png') })
  })
})
